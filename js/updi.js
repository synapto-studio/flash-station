// UPDI programming over a serial adapter ("SerialUPDI"), for the Adafruit UPDI Friend.
//
// A JavaScript port of the SerialUPDI stack in Microchip's pymcuprog (MIT licence):
// physical layer -> data link -> read/write -> NVM controller (P:0, tinyAVR 0/1-series).
// The byte sequences sent are the same as pymcuprog's, so it behaves like the tool the
// firmware guides already use from the terminal.
//
// The transport is anything with open/close/write/read (see serial.js for Web Serial,
// test/sim-transport.mjs for the simulated chip).

import { MAP, FUSE, WRITABLE_FUSES, deviceById, hexId } from './devices.js';

// ---- protocol constants (pymcuprog serialupdi/constants.py) ----
const BREAK = 0x00;
const LDS = 0x00, STS = 0x40, LD = 0x20, ST = 0x60, LDCS = 0x80, STCS = 0xc0, REPEAT = 0xa0, KEY = 0xe0;
const PTR_INC = 0x04, PTR_ADDRESS = 0x08;
const ADDRESS_16 = 0x04, ADDRESS_24 = 0x08;
const DATA_8 = 0x00, DATA_16 = 0x01, DATA_24 = 0x02;
const KEY_SIB = 0x04, KEY_KEY = 0x00, KEY_64 = 0x00, SIB_32BYTES = 0x02;
const REPEAT_BYTE = 0x00;
const SYNC = 0x55, ACK = 0x40;
const MAX_REPEAT = 0x100;

const CS_STATUSA = 0x00, CS_CTRLA = 0x02, CS_CTRLB = 0x03;
const ASI_KEY_STATUS = 0x07, ASI_RESET_REQ = 0x08, ASI_SYS_STATUS = 0x0b;
const CTRLA_IBDLY = 1 << 7, CTRLA_RSD = 1 << 3;
const CTRLB_CCDETDIS = 1 << 3, CTRLB_UPDIDIS = 1 << 2;
const KEY_NVM = 'NVMProg ';
const KEY_STATUS_NVMPROG = 1 << 4;
const SYS_STATUS_NVMPROG = 1 << 3, SYS_STATUS_LOCKSTATUS = 1 << 0;
const RESET_REQ_VALUE = 0x59;

// NVMCTRL (P:0)
const NVM_CTRLA = 0x00, NVM_STATUS = 0x02, NVM_DATA = 0x06, NVM_ADDR = 0x08;
const CMD_WRITE_PAGE = 0x01, CMD_ERASE_WRITE_PAGE = 0x03, CMD_PAGE_BUFFER_CLR = 0x04,
  CMD_CHIP_ERASE = 0x05, CMD_WRITE_FUSE = 0x07;
const STATUS_WRITE_ERROR = 1 << 2, STATUS_EEPROM_BUSY = 1 << 1, STATUS_FLASH_BUSY = 1 << 0;

export class UpdiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ physical layer
class Physical {
  constructor(transport, baud, timeoutMs, log) {
    this.t = transport;
    this.baud = baud;
    this.timeout = timeoutMs;
    this.log = log;
  }

  serialOptions(baud, stopBits) {
    return { baudRate: baud, dataBits: 8, parity: 'even', stopBits };
  }

  async open() {
    await this.t.open(this.serialOptions(this.baud, 2));
    // An initial break character as a handshake: wakes the UPDI pin up. Its echo also
    // proves the programmer is there (the UPDI Friend loops its TX back to its RX).
    await this.t.write([BREAK]);
    const echo = await this.t.read(1, this.timeout);
    if (echo.length < 1) {
      throw new UpdiError('no-echo',
        "The programmer isn't answering. Check it's plugged in and that you picked the UPDI Friend's port.");
    }
  }

  async close() {
    await this.t.close();
  }

  // Two 30 ms low pulses at 300 baud push UPDI back to a known state.
  async doubleBreak() {
    this.log('double break');
    await this.t.close();
    await this.t.open(this.serialOptions(300, 1));
    await this.t.write([BREAK]);
    await this.t.read(1, this.timeout);
    await sleep(100);
    await this.t.write([BREAK]);
    await this.t.read(1, this.timeout);
    await this.t.close();
    await this.t.open(this.serialOptions(this.baud, 2));
  }

  // Send bytes. Every byte echoes back, so read and drop the echo.
  async send(bytes) {
    await this.t.write(bytes);
    const echo = await this.t.read(bytes.length, this.timeout);
    if (echo.length < bytes.length) {
      throw new UpdiError('no-echo', 'The programmer stopped answering part-way through. Check its USB cable.');
    }
  }

  async receive(n) {
    return this.t.read(n, this.timeout);
  }

  async sib() {
    await this.send([SYNC, KEY | KEY_SIB | SIB_32BYTES]);
    return this.t.read(32, this.timeout);
  }
}

// ------------------------------------------------------------------ data link
class Datalink {
  constructor(phy, addressBytes) {
    this.phy = phy;
    this.addressBytes = addressBytes; // 2 (16-bit) or 3 (24-bit)
  }

  addr(address) {
    const a = [address & 0xff, (address >> 8) & 0xff];
    if (this.addressBytes === 3) a.push((address >> 16) & 0xff);
    return a;
  }
  get addressFlag() {
    return this.addressBytes === 3 ? ADDRESS_24 : ADDRESS_16;
  }
  get ptrDataFlag() {
    return this.addressBytes === 3 ? DATA_24 : DATA_16;
  }

  async init() {
    await this.initSession();
    if (!(await this.check())) {
      await this.phy.doubleBreak();
      await this.initSession();
      if (!(await this.check())) {
        throw new UpdiError('no-chip', 'No chip answered.');
      }
    }
  }

  async initSession() {
    await this.stcs(CS_CTRLB, CTRLB_CCDETDIS);
    await this.stcs(CS_CTRLA, CTRLA_IBDLY);
  }

  async check() {
    try {
      return (await this.ldcs(CS_STATUSA)) !== 0;
    } catch (e) {
      if (e.code === 'protocol') return false;
      throw e;
    }
  }

  async ldcs(address) {
    await this.phy.send([SYNC, LDCS | (address & 0x0f)]);
    const r = await this.phy.receive(1);
    if (r.length !== 1) throw new UpdiError('protocol', 'No reply to LDCS');
    return r[0];
  }

  async stcs(address, value) {
    await this.phy.send([SYNC, STCS | (address & 0x0f), value & 0xff]);
  }

  async ldPtrInc(size) {
    await this.phy.send([SYNC, LD | PTR_INC | DATA_8]);
    return this.phy.receive(size);
  }

  async ldPtrInc16(words) {
    await this.phy.send([SYNC, LD | PTR_INC | DATA_16]);
    return this.phy.receive(words << 1);
  }

  async expectAck(what) {
    const r = await this.phy.receive(1);
    if (r.length !== 1 || r[0] !== ACK) throw new UpdiError('protocol', `No ACK (${what})`);
  }

  async stPtrInc(data) {
    await this.phy.send([SYNC, ST | PTR_INC | DATA_8, data[0]]);
    await this.expectAck('st_ptr_inc');
    for (let i = 1; i < data.length; i++) {
      await this.phy.send([data[i]]);
      await this.expectAck('st_ptr_inc');
    }
  }

  async stPtrInc16(data) {
    if (data.length === 2) {
      await this.phy.send([SYNC, ST | PTR_INC | DATA_16, data[0], data[1]]);
      await this.expectAck('st_ptr_inc16');
      return;
    }
    // A block: switch the chip's replies off, send it all, switch them back on.
    await this.stcs(CS_CTRLA, CTRLA_IBDLY | CTRLA_RSD);
    await this.phy.send([SYNC, ST | PTR_INC | DATA_16]);
    await this.phy.send(data);
    await this.stcs(CS_CTRLA, CTRLA_IBDLY);
  }

  async repeat(n) {
    if (n - 1 > MAX_REPEAT) throw new UpdiError('protocol', 'Invalid repeat count');
    await this.phy.send([SYNC, REPEAT | REPEAT_BYTE, (n - 1) & 0xff]);
  }

  async key(size, key) {
    const bytes = Array.from(key, (c) => (typeof c === 'string' ? c.charCodeAt(0) : c));
    if (bytes.length !== 8 << size) throw new UpdiError('protocol', 'Invalid key length');
    await this.phy.send([SYNC, KEY | KEY_KEY | size]);
    await this.phy.send(bytes.reverse());
  }

  async ld(address) {
    await this.phy.send([SYNC, LDS | this.addressFlag | DATA_8, ...this.addr(address)]);
    const r = await this.phy.receive(1);
    if (r.length !== 1) throw new UpdiError('protocol', 'No reply to LD');
    return r[0];
  }

  async st(address, value) {
    await this.phy.send([SYNC, STS | this.addressFlag | DATA_8, ...this.addr(address)]);
    await this.expectAck('st');
    await this.phy.send([value & 0xff]);
    await this.expectAck('st');
  }

  async st16(address, value) {
    await this.phy.send([SYNC, STS | this.addressFlag | DATA_16, ...this.addr(address)]);
    await this.expectAck('st16');
    await this.phy.send([value & 0xff, (value >> 8) & 0xff]);
    await this.expectAck('st16');
  }

  async stPtr(address) {
    await this.phy.send([SYNC, ST | PTR_ADDRESS | this.ptrDataFlag, ...this.addr(address)]);
    await this.expectAck('st_ptr');
  }

  // ---- read/write helpers (pymcuprog readwrite.py) ----
  async readData(address, size) {
    if (size > MAX_REPEAT) throw new UpdiError('protocol', `Can't read ${size} bytes in one go`);
    await this.stPtr(address);
    if (size > 1) await this.repeat(size);
    const r = await this.ldPtrInc(size);
    if (r.length !== size) throw new UpdiError('protocol', `Read returned ${r.length} of ${size} bytes`);
    return r;
  }

  async writeDataWords(address, data) {
    if (data.length === 2) return this.st16(address, data[0] | (data[1] << 8));
    if (data.length > MAX_REPEAT << 1) throw new UpdiError('protocol', 'Block too big');
    await this.stPtr(address);
    await this.repeat(data.length >> 1);
    return this.stPtrInc16(data);
  }

  async writeData(address, data) {
    if (data.length === 1) return this.st(address, data[0]);
    if (data.length === 2) {
      await this.st(address, data[0]);
      return this.st(address + 1, data[1]);
    }
    let i = 0;
    while (i < data.length) {
      const chunk = data.slice(i, i + MAX_REPEAT);
      await this.stPtr(address + i);
      await this.repeat(chunk.length);
      await this.stPtrInc(chunk);
      i += chunk.length;
    }
  }
}

export function decodeSib(bytes) {
  const s = String.fromCharCode(...bytes);
  if (s.length < 19 || /[^\x20-\x7e\x00]/.test(s)) return null;
  const nvm = s.slice(8, 11).trim();
  return {
    raw: s.replace(/\0+$/, ''),
    family: s.slice(0, 7).trim(),
    nvm: nvm.includes(':') ? nvm.split(':')[1] : nvm,
  };
}

// ------------------------------------------------------------------ the programmer
export class UpdiProgrammer {
  constructor(transport, { baud = 115200, timeoutMs = 1000, log = () => {} } = {}) {
    this.log = log;
    this.phy = new Physical(transport, baud, timeoutMs, log);
    this.link = null;
    this.device = null;
    this.inProg = false;
  }

  // Open the port, wake UPDI, read the system information block, set up for P:0.
  async connect() {
    await this.phy.open();
    let link = new Datalink(this.phy, 3);
    await link.init();
    let sib = decodeSib(await this.phy.sib());
    if (!sib) {
      this.log('SIB unreadable, trying a double break');
      await this.phy.doubleBreak();
      sib = decodeSib(await this.phy.sib());
      if (!sib) throw new UpdiError('no-chip', 'No chip answered.');
    }
    this.log(`SIB: ${sib.raw}`);
    if (sib.nvm !== '0') {
      throw new UpdiError('unsupported', `This chip uses NVM version P:${sib.nvm}; only tinyAVR (P:0) chips are supported.`);
    }
    link = new Datalink(this.phy, 2);
    await link.init();
    this.link = link;
    this.sib = sib;
    return sib;
  }

  async readCs(a) {
    return this.link.ldcs(a);
  }
  async writeCs(a, v) {
    return this.link.stcs(a, v);
  }

  async reset(apply) {
    await this.writeCs(ASI_RESET_REQ, apply ? RESET_REQ_VALUE : 0x00);
  }

  async isInProgMode() {
    return ((await this.readCs(ASI_SYS_STATUS)) & SYS_STATUS_NVMPROG) !== 0;
  }

  async waitUnlocked(timeoutMs) {
    const end = now() + timeoutMs;
    do {
      if (!((await this.readCs(ASI_SYS_STATUS)) & SYS_STATUS_LOCKSTATUS)) return true;
    } while (now() < end);
    return false;
  }

  async enterProgMode() {
    if (await this.isInProgMode()) {
      this.inProg = true;
      return;
    }
    await this.reset(true);
    await this.link.key(KEY_64, KEY_NVM);
    const ks = await this.readCs(ASI_KEY_STATUS);
    if (!(ks & KEY_STATUS_NVMPROG)) throw new UpdiError('key', `Programming key not accepted (status 0x${ks.toString(16)})`);
    await this.reset(true);
    await this.reset(false);
    if (!(await this.waitUnlocked(100))) {
      throw new UpdiError('locked', 'The chip is locked. It can only be unlocked by erasing it.');
    }
    if (!(await this.isInProgMode())) throw new UpdiError('progmode', "The chip didn't enter programming mode.");
    this.inProg = true;
  }

  async leaveProgMode() {
    await this.reset(true);
    await this.reset(false);
    await this.writeCs(CS_CTRLB, CTRLB_UPDIDIS | CTRLB_CCDETDIS);
    this.inProg = false;
  }

  // Everything the app needs to know about the chip on the pins.
  async identify() {
    await this.enterProgMode();
    const sig = await this.link.readData(MAP.sigrow, 3);
    const id = (sig[0] << 16) | (sig[1] << 8) | sig[2];
    const device = deviceById(id);
    const rev = (await this.link.readData(MAP.syscfg + 1, 1))[0];
    const serial = await this.link.readData(MAP.serial, 10);
    const fuses = await this.link.readData(MAP.fuses, 9);
    const lock = (await this.link.readData(MAP.lockbits, 1))[0];
    const userRow = await this.link.readData(MAP.userRow, MAP.userRowSize);
    this.device = device;
    return {
      id,
      idHex: hexId(id),
      device,
      revision: String.fromCharCode(65 + (rev & 0x0f)),
      serial: Array.from(serial, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(),
      fuses: Array.from(fuses),
      lock,
      userRow: Uint8Array.from(userRow),
    };
  }

  requireDevice() {
    if (!this.device) throw new UpdiError('unknown', 'Unknown chip: identify it first.');
    return this.device;
  }

  // ---- NVM controller (pymcuprog serialupdi/nvmp0.py) ----
  async nvmReady(timeoutMs = 100) {
    const end = now() + timeoutMs;
    do {
      const s = await this.link.ld(MAP.nvmctrl + NVM_STATUS);
      if (s & STATUS_WRITE_ERROR) throw new UpdiError('nvm', 'The chip reported a write error.');
      if (!(s & (STATUS_EEPROM_BUSY | STATUS_FLASH_BUSY))) return;
    } while (now() < end);
    throw new UpdiError('nvm-timeout', 'The chip stayed busy too long.');
  }

  async nvmCommand(cmd) {
    await this.link.st(MAP.nvmctrl + NVM_CTRLA, cmd);
  }

  // Erases flash (and EEPROM unless the chip is set to keep it). Never touches the user row.
  async chipErase() {
    await this.nvmReady();
    await this.nvmCommand(CMD_CHIP_ERASE);
    await this.nvmReady(1000);
  }

  async writeFlashPage(address, data) {
    await this.nvmReady();
    await this.nvmCommand(CMD_PAGE_BUFFER_CLR);
    await this.nvmReady();
    await this.link.writeDataWords(address, data);
    await this.nvmCommand(CMD_WRITE_PAGE);
    await this.nvmReady();
  }

  // Write flash from a byte array placed at `offset` (a flash offset, 0 = first byte).
  // Pages that are entirely 0xFF are skipped: a chip erase has already blanked them.
  async writeFlash(offset, bytes, onProgress = () => {}) {
    const dev = this.requireDevice();
    const page = dev.flashPage;
    if (offset % page) throw new UpdiError('align', 'Flash writes must start on a page boundary');
    if (offset + bytes.length > dev.flashSize) throw new UpdiError('size', 'Too big for this chip');
    const pages = [];
    for (let p = 0; p < bytes.length; p += page) {
      const chunk = new Uint8Array(page).fill(0xff);
      chunk.set(bytes.subarray(p, p + page));
      if (chunk.some((b) => b !== 0xff)) pages.push([offset + p, chunk]);
    }
    for (let i = 0; i < pages.length; i++) {
      const [off, chunk] = pages[i];
      await this.writeFlashPage(MAP.flash + off, Array.from(chunk));
      onProgress(i + 1, pages.length);
    }
    return pages.length;
  }

  async readFlash(offset, length, onProgress = () => {}) {
    this.requireDevice();
    const out = new Uint8Array(length);
    for (let p = 0; p < length; p += MAX_REPEAT) {
      const n = Math.min(MAX_REPEAT, length - p);
      out.set(await this.link.readData(MAP.flash + offset + p, n), p);
      onProgress(Math.min(p + n, length), length);
    }
    return out;
  }

  async readFuses() {
    return Array.from(await this.link.readData(MAP.fuses, 9));
  }

  async writeFuse(index, value) {
    if (!WRITABLE_FUSES.includes(index)) {
      throw new UpdiError('fuse', `Refusing to write fuse ${index}: only APPEND and BOOTEND are ever changed.`);
    }
    const address = MAP.fuses + index;
    await this.nvmReady();
    await this.link.st(MAP.nvmctrl + NVM_ADDR, address & 0xff);
    await this.link.st(MAP.nvmctrl + NVM_ADDR + 1, (address >> 8) & 0xff);
    await this.link.st(MAP.nvmctrl + NVM_DATA, value & 0xff);
    await this.nvmCommand(CMD_WRITE_FUSE);
    await this.nvmReady();
  }

  // The user row is 32 bytes of EEPROM-like memory that survives chip erase.
  async writeUserRow(bytes) {
    if (bytes.length > MAP.userRowSize) throw new UpdiError('size', 'The user row is 32 bytes');
    await this.nvmReady();
    await this.nvmCommand(CMD_PAGE_BUFFER_CLR);
    await this.nvmReady();
    await this.link.writeData(MAP.userRow, Array.from(bytes));
    await this.nvmCommand(CMD_ERASE_WRITE_PAGE);
    await this.nvmReady();
  }

  async readUserRow() {
    return Uint8Array.from(await this.link.readData(MAP.userRow, MAP.userRowSize));
  }

  // Leave programming mode (the chip starts running) and close the port.
  async disconnect() {
    try {
      if (this.link) await this.leaveProgMode();
    } finally {
      this.link = null;
      await this.phy.close();
    }
  }
}

export { FUSE };
