// A simulated tinyAVR chip on a simulated UPDI Friend, so the app (and its tests) can run
// with no hardware. It models the parts of UPDI and the NVM controller the programmer uses:
// echo on the line, SYNC framing, LDS/STS/LD/ST/LDCS/STCS/REPEAT/KEY/SIB, response-signature
// disable, the NVMPROG key and reset sequence, the page buffer, page write, chip erase,
// fuse write and the EEPROM-style user row.

import { DEVICES, MAP } from './devices.js';

const SYNC = 0x55, ACK = 0x40;
const SIB_TEXT = 'tinyAVR P:0D:0-3M2 (01.59B14.0) ';
const KEYS = { 'NVMProg ': 1 << 4, NVMErase: 1 << 3, 'NVMUs&te': 1 << 5 };

export class SimChip {
  constructor(deviceKey = 'attiny1614', { serial = null, revision = 3 } = {}) {
    const d = DEVICES[deviceKey];
    if (!d) throw new Error(`Unknown simulated device ${deviceKey}`);
    this.dev = d;
    this.flash = new Uint8Array(d.flashSize).fill(0xff);
    this.eeprom = new Uint8Array(d.eepromSize).fill(0xff);
    this.userRow = new Uint8Array(MAP.userRowSize).fill(0xff);
    // WDTCFG BODCFG OSCCFG (20 MHz) - TCD0CFG SYSCFG0 SYSCFG1 APPEND BOOTEND
    this.fuses = [0x00, 0x00, 0x02, 0xff, 0x00, 0xf6, 0x07, 0x00, 0x00];
    this.lock = 0xc5; // no lock
    this.revision = revision;
    this.serial = serial || Uint8Array.from({ length: 10 }, (_, i) => (0x30 + i * 7 + d.id) & 0xff);
    this.reset();
    this.stats = { pageWrites: 0, chipErases: 0, fuseWrites: 0, userRowWrites: 0 };
  }

  // Power-on / double break: UPDI back to idle.
  reset() {
    this.updiEnabled = false;
    this.cs = new Uint8Array(16);
    this.cs[0] = 0x10; // STATUSA: UPDI revision 1
    this.keyStatus = 0;
    this.resetAsserted = false;
    this.nvmProg = false;
    this.ptr = 0;
    this.repeatCount = 0;
    this.pageBuf = new Map();
    this.lastAddr = 0;
    this.nvmAddr = 0;
    this.nvmData = 0;
    this.busy = 0;
    this.machine = this.run();
    this.machine.next();
    this.out = [];
  }

  doubleBreak() {
    const keep = { flash: this.flash, eeprom: this.eeprom, userRow: this.userRow, fuses: this.fuses, lock: this.lock };
    this.reset();
    Object.assign(this, keep);
    this.updiEnabled = true;
  }

  // One byte arrives from the programmer. Returns the bytes the chip sends back.
  feed(b) {
    this.out = [];
    if (!this.updiEnabled) {
      // A falling edge (the 0x00 handshake, or any start bit) wakes UPDI; that byte is lost.
      this.updiEnabled = true;
      return [];
    }
    this.machine.next(b);
    return this.out;
  }

  get rsd() {
    return (this.cs[2] & (1 << 3)) !== 0;
  }

  *run() {
    for (;;) {
      let b = yield;
      if (b !== SYNC) continue;
      const op = yield;
      const kind = op & 0xe0;
      if (kind === 0x00 || kind === 0x40) {
        // LDS / STS: direct addressing
        const nAddr = ((op >> 2) & 3) + 1;
        const nData = (op & 3) + 1;
        let addr = 0;
        for (let i = 0; i < nAddr; i++) addr |= (yield) << (8 * i);
        if (kind === 0x00) {
          for (let i = 0; i < nData; i++) this.out.push(this.read(addr + i));
        } else {
          if (!this.rsd) this.out.push(ACK);
          for (let i = 0; i < nData; i++) this.write(addr + i, yield);
          if (!this.rsd) this.out.push(ACK);
        }
      } else if (kind === 0x20 || kind === 0x60) {
        // LD / ST through the pointer
        const mode = (op >> 2) & 3; // 0 *ptr, 1 *ptr++, 2 ptr itself
        const size = (op & 3) + 1;
        if (kind === 0x60 && mode === 2) {
          let addr = 0;
          for (let i = 0; i < size; i++) addr |= (yield) << (8 * i);
          this.ptr = addr;
          if (!this.rsd) this.out.push(ACK);
          continue;
        }
        if (kind === 0x20 && mode === 2) {
          for (let i = 0; i < size; i++) this.out.push((this.ptr >> (8 * i)) & 0xff);
          continue;
        }
        const n = this.repeatCount + 1;
        this.repeatCount = 0;
        for (let k = 0; k < n; k++) {
          if (kind === 0x20) {
            for (let i = 0; i < size; i++) this.out.push(this.read(this.ptr + i));
          } else {
            for (let i = 0; i < size; i++) this.write(this.ptr + i, yield);
            if (!this.rsd) this.out.push(ACK);
          }
          if (mode === 1) this.ptr += size;
        }
      } else if (kind === 0x80) {
        this.out.push(this.readCs(op & 0x0f));
      } else if (kind === 0xc0) {
        this.writeCs(op & 0x0f, yield);
      } else if (kind === 0xa0) {
        this.repeatCount = yield;
        if (op & 1) this.repeatCount |= (yield) << 8;
      } else if (kind === 0xe0) {
        const len = 8 << (op & 3);
        if (op & 0x04) {
          for (let i = 0; i < len; i++) this.out.push(i < SIB_TEXT.length ? SIB_TEXT.charCodeAt(i) : 0x20);
        } else {
          const key = [];
          for (let i = 0; i < len; i++) key.push(yield);
          const text = String.fromCharCode(...key.reverse());
          if (KEYS[text]) this.keyStatus |= KEYS[text];
        }
      }
    }
  }

  readCs(a) {
    if (a === 0x07) return this.keyStatus;
    if (a === 0x0b) {
      let s = 0;
      if (this.nvmProg) s |= 1 << 3;
      if (this.resetAsserted) s |= 1 << 5;
      if (this.lock !== 0xc5 && !this.nvmProg) s |= 1;
      return s;
    }
    return this.cs[a];
  }

  writeCs(a, v) {
    if (a === 0x08) {
      if (v === 0x59) this.resetAsserted = true;
      else if (this.resetAsserted) {
        this.resetAsserted = false;
        if (this.keyStatus & KEYS.NVMErase) {
          this.chipErase();
          this.lock = 0xc5;
          this.keyStatus &= ~KEYS.NVMErase;
        }
        if (this.keyStatus & KEYS['NVMProg ']) {
          if (this.lock === 0xc5) this.nvmProg = true;
          this.keyStatus &= ~KEYS['NVMProg '];
        }
      }
      return;
    }
    if (a === 0x07) {
      this.keyStatus &= ~v;
      return;
    }
    this.cs[a] = v;
    if (a === 0x03 && v & (1 << 2)) {
      // UPDIDIS: UPDI off, programming mode over, the chip runs.
      this.updiEnabled = false;
      this.nvmProg = false;
      this.keyStatus = 0;
      this.machine = this.run();
      this.machine.next();
    }
  }

  region(addr) {
    const d = this.dev;
    if (addr >= MAP.flash && addr < MAP.flash + d.flashSize) return { mem: this.flash, base: MAP.flash, page: d.flashPage, flash: true };
    if (addr >= MAP.eeprom && addr < MAP.eeprom + d.eepromSize) return { mem: this.eeprom, base: MAP.eeprom, page: d.eepromPage };
    if (addr >= MAP.userRow && addr < MAP.userRow + MAP.userRowSize) return { mem: this.userRow, base: MAP.userRow, page: MAP.userRowSize, userRow: true };
    return null;
  }

  read(addr) {
    addr &= 0xffff;
    const r = this.region(addr);
    if (r) return r.mem[addr - r.base];
    if (addr === MAP.nvmctrl + 0x02) {
      if (this.busy > 0) {
        this.busy--;
        return 0x01;
      }
      return 0x00;
    }
    if (addr === MAP.nvmctrl + 0x06) return this.nvmData & 0xff;
    if (addr === MAP.nvmctrl + 0x07) return this.nvmData >> 8;
    if (addr === MAP.nvmctrl + 0x08) return this.nvmAddr & 0xff;
    if (addr === MAP.nvmctrl + 0x09) return this.nvmAddr >> 8;
    if (addr >= MAP.sigrow && addr < MAP.sigrow + 3) return (this.dev.id >> (8 * (2 - (addr - MAP.sigrow)))) & 0xff;
    if (addr >= MAP.serial && addr < MAP.serial + 10) return this.serial[addr - MAP.serial];
    if (addr >= MAP.fuses && addr < MAP.fuses + 9) return this.fuses[addr - MAP.fuses];
    if (addr === MAP.lockbits) return this.lock;
    if (addr === MAP.syscfg + 1) return this.revision;
    return 0;
  }

  write(addr, v) {
    addr &= 0xffff;
    if (addr === MAP.nvmctrl) return this.command(v);
    if (addr === MAP.nvmctrl + 0x06) return void (this.nvmData = (this.nvmData & 0xff00) | v);
    if (addr === MAP.nvmctrl + 0x07) return void (this.nvmData = (this.nvmData & 0xff) | (v << 8));
    if (addr === MAP.nvmctrl + 0x08) return void (this.nvmAddr = (this.nvmAddr & 0xff00) | v);
    if (addr === MAP.nvmctrl + 0x09) return void (this.nvmAddr = (this.nvmAddr & 0xff) | (v << 8));
    const r = this.region(addr);
    if (r && this.nvmProg) {
      this.pageBuf.set(addr, v);
      this.lastAddr = addr;
    }
  }

  chipErase() {
    this.flash.fill(0xff);
    if (!(this.fuses[5] & 1)) this.eeprom.fill(0xff); // EESAVE keeps the EEPROM
    this.lock = 0xc5;
    this.pageBuf.clear();
    this.stats.chipErases++;
  }

  command(cmd) {
    if (!this.nvmProg) return;
    this.busy = 2;
    const r = this.region(this.lastAddr);
    const pageStart = r ? r.base + (((this.lastAddr - r.base) / r.page) | 0) * r.page : 0;
    const inPage = (a) => r && a >= pageStart && a < pageStart + r.page;
    switch (cmd) {
      case 0x00:
        break;
      case 0x01: // write page (AND into flash; EEPROM bytes written replace)
      case 0x03: // erase + write page
        if (!r) break;
        if (r.flash) {
          if (cmd === 0x03) r.mem.fill(0xff, pageStart - r.base, pageStart - r.base + r.page);
          for (const [a, v] of this.pageBuf) if (inPage(a)) r.mem[a - r.base] &= v;
          this.stats.pageWrites++;
        } else {
          for (const [a, v] of this.pageBuf) if (inPage(a)) r.mem[a - r.base] = cmd === 0x03 ? v : r.mem[a - r.base] & v;
          if (r.userRow) this.stats.userRowWrites++;
        }
        this.pageBuf.clear();
        break;
      case 0x02: // erase page
        if (r) r.mem.fill(0xff, pageStart - r.base, pageStart - r.base + r.page);
        this.pageBuf.clear();
        break;
      case 0x04:
        this.pageBuf.clear();
        break;
      case 0x05:
        this.chipErase();
        break;
      case 0x06:
        this.eeprom.fill(0xff);
        break;
      case 0x07: // write fuse
        if (this.nvmAddr >= MAP.fuses && this.nvmAddr < MAP.fuses + 9) {
          this.fuses[this.nvmAddr - MAP.fuses] = this.nvmData & 0xff;
          this.stats.fuseWrites++;
        } else if (this.nvmAddr === MAP.lockbits) this.lock = this.nvmData & 0xff;
        break;
      default:
        break;
    }
  }
}

// A transport (same shape as WebSerialTransport) wired to a simulated chip.
// With chip = null it is a UPDI Friend with nothing on its pin: echo only.
export class SimTransport {
  constructor(chip, { delayMs = 0 } = {}) {
    this.chip = chip;
    this.rx = [];
    this.isOpen = false;
    this.options = null;
    this.delayMs = delayMs;
    this.log = [];
    this.simulated = true;
  }

  describe() {
    return this.chip ? `Simulated ${this.chip.dev.name}` : 'Simulated UPDI Friend, nothing on the pin';
  }

  async open(options) {
    if (this.isOpen) throw new Error('already open');
    this.isOpen = true;
    this.options = options;
    this.rx = [];
  }

  async close() {
    this.isOpen = false;
  }

  async write(bytes) {
    if (!this.isOpen) throw new Error('port not open');
    for (const b of bytes) {
      this.log.push(b);
      this.rx.push(b); // the UPDI Friend's echo
      if (!this.chip) continue;
      if (this.options.baudRate === 300) {
        if (b === 0x00) this.chip.doubleBreak();
        continue;
      }
      this.rx.push(...this.chip.feed(b));
    }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async read(n) {
    if (!this.isOpen) throw new Error('port not open');
    if (this.delayMs) await new Promise((r) => setTimeout(r, 0));
    return Uint8Array.from(this.rx.splice(0, n));
  }
}
