// A simulated station box with a simulated drive in its socket, so the Flash Station tab
// and its tests need no hardware. SimDrive is pulsetest's bootloader frame decoder: it
// finds 5A A5 frames in the power-line bytes, checks the CRC, writes only pages that
// differ, marks the routine unfinished at the first change and is valid again only when
// the trailer lands and everything adds up. SimCoreDrive is coretest 1.3's receiver.

import { crc16 } from './crc.js';
import { crc8, helloAnswer, PLUG_COPIES } from './station.js';
import { PULSE, packSettings, unpackSettings } from './engines.js';

const LEN = { 0x48: 36, 0x50: 68, 0x54: 3 }; // H, P, T
const le16 = (b, i) => b[i] | (b[i + 1] << 8);

// What a drive flickers when it powers up on a station: nothing on today's engines, its ID
// card (3 copies) on ones that introduce themselves (coretest 1.4, pulsetest 1.1), with its
// lighting fingerprint on ones that say what lighting they have (tellsLighting: 1.5 on).
function powerUp(drive) {
  if (!drive.announces) return new Uint8Array(0);
  return helloAnswer(drive.card, PLUG_COPIES, drive.tellsLighting ? drive.fingerprint() : null);
}

export class SimDrive {
  constructor(image, card = null) {
    this.card = card;
    this.announces = false;
    this.tellsLighting = false;
    this.pages = new Map(image.pages().map(([p, d]) => [p, Uint8Array.from(d)]));
    this.valid = true;
    this.buf = [];
    this.header = null;
    this.colour = null;
    this.tests = 0;
    this.pageWrites = 0;
    this.rejected = 0;
  }

  powerUp() {
    return powerUp(this);
  }

  feed(bytes) {
    this.buf.push(...bytes);
    for (;;) {
      const b = this.buf;
      let i = 0;
      while (i + 1 < b.length && !(b[i] === 0x5a && b[i + 1] === 0xa5)) i++;
      if (i) b.splice(0, i);
      if (b.length < 4) return;
      const len = LEN[b[2]];
      if (len === undefined || b[3] !== len) {
        b.shift();
        continue;
      }
      if (b.length < len + 6) return; // the rest comes in the next SEND
      const body = b.slice(2, 4 + len);
      if (crc16(body) !== le16(b, 4 + len)) {
        this.rejected++;
        b.shift();
        continue;
      }
      b.splice(0, len + 6);
      this.handle(body[0], Uint8Array.from(body.slice(2)));
    }
  }

  codeCrc(setPage = this.setPage()) {
    const app = this.app();
    const i = setPage * PULSE.PAGE;
    return crc16(Uint8Array.from([...app.subarray(0, i), ...app.subarray(i + PULSE.PAGE)]));
  }

  setPage() {
    return this.pages.get(PULSE.TRAILER_PAGE)[10];
  }

  app() {
    const t = this.pages.get(PULSE.TRAILER_PAGE);
    const len = le16(t, 4);
    const out = new Uint8Array(Math.ceil(len / PULSE.PAGE) * PULSE.PAGE);
    for (let p = 0; p * PULSE.PAGE < len; p++) out.set(this.pages.get(p) || [], p * PULSE.PAGE);
    return out.subarray(0, len);
  }

  imageValid() {
    const t = this.pages.get(PULSE.TRAILER_PAGE);
    if (!t || String.fromCharCode(...t.subarray(0, 4)) !== 'SPL1') return false;
    if (crc16(t.subarray(0, 62)) !== le16(t, 62)) return false;
    const len = le16(t, 4);
    if (len > PULSE.APP_MAX || t[10] * PULSE.PAGE >= len) return false;
    const app = this.app();
    return crc16(app) === le16(t, 6) && this.codeCrc(t[10]) === le16(t, 8);
  }

  // pulsetest 1.5: the trailer's app CRC, FFFF when an update was cut off.
  fingerprint() {
    return this.valid ? le16(this.pages.get(PULSE.TRAILER_PAGE), 6) : 0xffff;
  }

  settings() {
    const i = this.setPage() * PULSE.PAGE;
    return unpackSettings('SOTA.PLS', this.app().subarray(i, i + 64));
  }

  handle(type, p) {
    if (type === 0x54) {
      this.colour = [p[0], p[1], p[2]];
      this.tests++;
    } else if (type === 0x48) {
      this.header = {
        imageId: le16(p, 0), patch: !!(p[2] & 1), appLen: le16(p, 3), appCrc: le16(p, 5),
        codeCrc: le16(p, 7), setPage: p[9], mask: p.subarray(10, 36),
      };
    } else if (type === 0x50) {
      this.page({ imageId: le16(p, 0), patch: !!(p[2] & 1), index: p[3], data: p.subarray(4, 68) });
    }
  }

  page({ imageId, patch, index, data }) {
    const h = this.header;
    const inMask = h && index < 208 && h.mask[index >> 3] & (1 << (index & 7));
    if (!h || h.imageId !== imageId || h.patch !== patch || !inMask) return this.rejected++;
    if (patch) {
      // A settings patch may touch only the settings page, the pages after the routine (engine 2's
      // show) and the trailer, and only on a drive whose code is the code the patch was made for.
      // (The real bootloader takes any page in the header's list: the app only lists these.)
      if (index !== h.setPage && index !== PULSE.TRAILER_PAGE && index * PULSE.PAGE < h.appLen) return this.rejected++;
      if (this.codeCrc(h.setPage) !== h.codeCrc) return this.rejected++;
    }
    const old = this.pages.get(index);
    if (!old || !old.every((v, i) => v === data[i])) {
      this.valid = false; // unfinished from the first change
      this.pages.set(index, Uint8Array.from(data));
      this.pageWrites++;
    }
    // The trailer is checked whenever it arrives, even if it was already there.
    if (index === PULSE.TRAILER_PAGE) this.valid = this.imageValid() && crc16(Uint8Array.from([...this.app(), ...data])) === h.imageId;
  }
}

// coretest 1.3's receiver (handleMessage and onByte in coretest.ino), byte for byte: find
// 5A A5, take len (1 to 101), the payload and its CRC-8. A bad byte just drops the message
// and the hunt for 5A A5 starts again. Settings sent by the station live in EEPROM (98
// bytes from the layout byte on, then their CRC-16) and win over the ones in the flash.
const CORE_SET_LEN = 98;
const CORE_MSG_MAX = 1 + CORE_SET_LEN + 2;
const CORE_HELLO_COPIES_15 = 34;   // coretest 1.5's longer frame: 34 copies in its 3.1 s

export class SimCoreDrive {
  // card: the 32-byte ID card in the user row, or null for a drive without one.
  constructor(settings, card = null) {
    this.card = card;
    this.announces = false;
    this.tellsLighting = false;
    this.answer = null; // bytes flickered back after the last hello
    this.flash = packSettings('SOTA.LED', settings); // the tagged block in the flashed engine
    this.ee = new Uint8Array(128).fill(0xff); // ATtiny412 EEPROM, erased when initialised
    this.rx = { state: 0, len: 0, pos: 0, crc: 0, msg: [] };
    this.colour = null;
    this.tests = 0;
    this.hellos = 0;
    this.heard = 0; // messages whose CRC-8 was right
    this.eeWrites = 0;
    this.restarts = 0;
  }

  powerUp() {
    return powerUp(this);
  }

  feed(bytes) {
    for (const b of bytes) this.onByte(b);
  }

  onByte(b) {
    const r = this.rx, s = r.state;
    r.state = 0;
    if (s === 0) { if (b === 0x5a) r.state = 1; }
    else if (s === 1) { if (b === 0xa5) r.state = 2; else if (b === 0x5a) r.state = 1; }
    else if (s === 2) { if (b && b <= CORE_MSG_MAX) { r.len = b; r.msg = []; r.crc = crc8([b]); r.state = 3; } }
    else if (s === 3) { r.msg.push(b); r.crc = crc8([b], r.crc); r.state = r.msg.length < r.len ? 3 : 4; }
    else if (b === r.crc) { this.heard++; this.handle(Uint8Array.from(r.msg)); }
  }

  eepromValid() {
    const e = this.ee;
    return e[0] === this.flash[8] && crc16(e.subarray(0, CORE_SET_LEN)) === (e[CORE_SET_LEN] | (e[CORE_SET_LEN + 1] << 8));
  }

  source() {
    return this.eepromValid() ? 'eeprom' : 'flash';
  }

  // coretest 1.5: CRC-16 of the 98 settings bytes in use.
  fingerprint() {
    return crc16(this.eepromValid() ? this.ee.subarray(0, CORE_SET_LEN) : this.flash.subarray(8));
  }

  settings() {
    if (!this.eepromValid()) return unpackSettings('SOTA.LED', this.flash);
    return unpackSettings('SOTA.LED', Uint8Array.from([...this.flash.subarray(0, 8), ...this.ee.subarray(0, CORE_SET_LEN)]));
  }

  handle(m) {
    const type = m[0], p = m.subarray(1), len = m.length;
    if (type === 1 && len === 4) {
      this.colour = [p[0], p[1], p[2]];
      this.tests++;
    } else if (type === 2 && len === CORE_MSG_MAX && p[0] === this.flash[8]
               && crc16(p.subarray(0, CORE_SET_LEN)) === (p[CORE_SET_LEN] | (p[CORE_SET_LEN + 1] << 8))) {
      const now = p.subarray(0, CORE_SET_LEN + 2);
      if (!now.every((v, i) => v === this.ee[i])) {
        this.ee.set(now);
        this.eeWrites++;
        this.restarts++;
      }
    } else if (type === 3 && len === 2 && p[0] === 0x5a && this.eepromValid()) {
      this.ee[CORE_SET_LEN] ^= 0xff;
      this.eeWrites++;
      this.restarts++;
    } else if (type === 4 && len === 1) {
      this.hellos++;
      this.answer = this.tellsLighting ? helloAnswer(this.card, CORE_HELLO_COPIES_15, this.fingerprint()) : helloAnswer(this.card);
    }
  }
}

// Same shape as WebSerialTransport, answering like station firmware 0.2 (0.1 has no ASK or
// WAIT; 0.3 also knows when its socket is empty: SOCKET, LEVELS, GONE, OK EMPTY; 0.6 has PROBE;
// 0.7 records each plug-in: TRACE).
// plugIn() and unplug() stand in for a hand at the socket.
export const SIM_LEVELS = 'LEVELS 6 30 750 28 72'; // what the emulated box reads (firmware listen_e2e.js)

// What a 0.7 box records at a plug-in (TRACE), made up from the same levels: 20 ms of the drive
// dark (30), the 150 ms signal (5 ms dips at 750, 5 ms full), then listening: what the drive
// flickered, 1 ms (10 readings) a bit, lit 72 / dark 28, or 0.4 s dark if it said nothing.
export function simTrace(heard) {
  const r = [];
  const add = (v, n) => { for (let i = 0; i < n; i++) r.push(v); };
  add(30, 200);
  const signalAt = r.length;
  for (let i = 0; i < 15; i++) { add(750, 50); add(30, 50); }
  const listenAt = r.length;
  if (!heard.length) add(30, 4000);
  else {
    add(72, 100);
    for (const b of heard) for (const bit of [0, ...Array.from({ length: 8 }, (_, k) => (b >> k) & 1), 1]) add(bit ? 72 : 28, 10);
  }
  return { signalAt, listenAt, readings: r };
}

export class SimStation {
  constructor(drive = null, { version = '0.2' } = {}) {
    this.drive = drive;
    this.version = version;
    this.rx = [];
    this.line = '';
    this.isOpen = false;
    this.simulated = true;
    this.elapsedMs = 0; // how long the real box would have taken
    this.sends = 0;
    this.events = []; // plug-ins ({ heard }) and unplugs ({ gone }) until a WAIT reports them
    this.waiting = null; // the WAIT in progress: { out, timer }
    this.levels = null;
    this.trace = null; // the last plug-in's recording (0.7: TRACE)
  }

  get knowsSocket() {
    return !['0.1', '0.2'].includes(this.version);
  }

  // Someone pushes a drive into the socket (or pulls it out).
  plugIn(drive) {
    this.drive = drive;
    const heard = drive.powerUp ? drive.powerUp() : new Uint8Array(0);
    this.events.push({ heard });
    this.levels = SIM_LEVELS;
    this.trace = simTrace(heard);
    if (this.waiting) this.report();
  }

  unplug() {
    const was = this.drive;
    this.drive = null;
    if (!was || !this.knowsSocket) return;
    this.events.push({ gone: true });
    if (this.waiting) this.report();
  }

  report() {
    const { out, timer } = this.waiting;
    clearTimeout(timer);
    this.waiting = null;
    const e = this.events.shift();
    if (e.gone) return out('GONE');
    const heard = Array.from(e.heard, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    out(`DRIVE ${heard}`.trim());
  }

  describe() {
    return 'Simulated station';
  }

  async open() {
    this.isOpen = true;
  }

  async close() {
    this.isOpen = false;
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = null;
  }

  async read(n) {
    // Nothing yet (a WAIT in progress): give the timers a moment, like a real serial read.
    if (!this.rx.length) await new Promise((r) => setTimeout(r, 2));
    return Uint8Array.from(this.rx.splice(0, n));
  }

  discard() {
    this.rx = [];
  }

  async write(bytes) {
    for (const c of bytes) {
      if (c === 10) {
        this.reply(this.line.trim());
        this.line = '';
      } else this.line += String.fromCharCode(c);
    }
  }

  reply(cmd) {
    const out = (s) => this.rx.push(...new TextEncoder().encode(`${s}\n`));
    const [name, baud, stop, hex, gap] = cmd.split(/\s+/);
    if (name === 'HELLO') return out(`SYNAPTO-STATION ${this.version}`);
    if (name === 'SENSE') return out('SENSE 2048 1650');
    if (name === 'SHOW') return out('OK');
    if (name === 'SOCKET' && this.knowsSocket) return out(this.drive ? 'SOCKET IN' : 'SOCKET EMPTY');
    if (name === 'LEVELS' && this.knowsSocket) return out(this.levels || 'LEVELS NONE');
    if (name === 'PROBE' && Number(this.version.split('.')[1]) >= 6) return out(this.drive ? 'PROBE 61 120 760 1030 1030' : 'PROBE 61 4 6 9 6');
    if (name === 'TRACE' && Number(this.version.split('.')[1]) >= 7) {
      if (!this.trace) return out('TRACE NONE');
      const { signalAt, listenAt, readings } = this.trace, from = Number(baud || 0);
      const hex = readings.slice(from, from + 1000).map((v) => v.toString(16).toUpperCase().padStart(3, '0')).join('');
      return out(`TRACE ${readings.length} ${signalAt} ${listenAt} ${from}${hex ? ` ${hex}` : ''}`);
    }
    if (name === 'WAIT' && this.version !== '0.1') {
      const ms = Number(baud);
      if (!(ms >= 1 && ms <= 60000)) return out('ERR wait must be 1 to 60000 ms');
      this.waiting = { out, timer: setTimeout(() => { this.waiting = null; out('NONE'); }, ms) };
      if (this.events.length) this.report(); // plugged in (or out) between two WAITs
      return;
    }
    const ask = name === 'ASK' && this.version !== '0.1';
    if (name !== 'SEND' && !ask) return out('ERR unknown command');
    const b = Number(baud), s = Number(stop), g = Number(gap);
    if (!(b >= 70 && b <= 20000)) return out('ERR baud must be 70 to 20000');
    if (s !== 1 && s !== 2) return out('ERR stop bits must be 1 or 2');
    if (!/^([0-9a-fA-F]{2}){1,4096}$/.test(hex || '')) return out('ERR hex must be 1 to 4096 bytes');
    if (!(g >= 0 && g <= 60000)) return out('ERR gap must be 0 to 60000 ms');
    const bytes = Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
    if (!this.drive && this.knowsSocket) {
      this.elapsedMs += (bytes.length * (9 + s) * 1000) / b + (ask ? 0 : g);
      return out('OK EMPTY');
    }
    if (this.drive) {
      this.drive.answer = null;
      this.drive.feed(bytes);
    }
    this.elapsedMs += (bytes.length * (9 + s) * 1000) / b + g;
    this.sends++;
    if (!ask) return out('OK');
    // 43 copies take 3 s: a shorter listen hears only the copies that fit.
    const heard = Array.from((this.drive && this.drive.answer) || []).slice(0, Math.max(0, (g - 500) / 10)); // 10 ms a byte, after ~0.5 s
    out(`HEARD ${heard.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`.trim());
  }
}
