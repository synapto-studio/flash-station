// A simulated station box with a simulated pulsetest drive in its socket, so the Flash
// Station tab and its tests need no hardware. The drive half is the bootloader's frame
// decoder: it finds 5A A5 frames in the power-line bytes, checks the CRC, writes only
// pages that differ, marks the routine unfinished at the first change and is valid again
// only when the trailer lands and everything adds up.

import { crc16 } from './crc.js';
import { PULSE, unpackSettings } from './engines.js';

const LEN = { 0x48: 36, 0x50: 68, 0x54: 3 }; // H, P, T
const le16 = (b, i) => b[i] | (b[i + 1] << 8);

export class SimDrive {
  constructor(image) {
    this.pages = new Map(image.pages().map(([p, d]) => [p, Uint8Array.from(d)]));
    this.valid = true;
    this.buf = [];
    this.header = null;
    this.colour = null;
    this.tests = 0;
    this.pageWrites = 0;
    this.rejected = 0;
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
      // A settings patch may touch only the settings page and the trailer, and only on a
      // drive whose code is the code the patch was made for.
      if (index !== h.setPage && index !== PULSE.TRAILER_PAGE) return this.rejected++;
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

// Same shape as WebSerialTransport, answering like station firmware 0.1.
export class SimStation {
  constructor(drive = null) {
    this.drive = drive;
    this.rx = [];
    this.line = '';
    this.isOpen = false;
    this.simulated = true;
    this.elapsedMs = 0; // how long the real box would have taken
    this.sends = 0;
  }

  describe() {
    return 'Simulated station';
  }

  async open() {
    this.isOpen = true;
  }

  async close() {
    this.isOpen = false;
  }

  async read(n) {
    return Uint8Array.from(this.rx.splice(0, n));
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
    if (name === 'HELLO') return out('SYNAPTO-STATION 0.1');
    if (name === 'SENSE') return out('SENSE 2048 1650');
    if (name === 'SHOW') return out('OK');
    if (name !== 'SEND') return out('ERR unknown command');
    const b = Number(baud), s = Number(stop), g = Number(gap);
    if (!(b >= 70 && b <= 20000)) return out('ERR baud must be 70 to 20000');
    if (s !== 1 && s !== 2) return out('ERR stop bits must be 1 or 2');
    if (!/^([0-9a-fA-F]{2}){1,4096}$/.test(hex || '')) return out('ERR hex must be 1 to 4096 bytes');
    if (!(g >= 0 && g <= 60000)) return out('ERR gap must be 0 to 60000 ms');
    const bytes = Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
    if (this.drive) this.drive.feed(bytes);
    this.elapsedMs += (bytes.length * (9 + s) * 1000) / b + g;
    this.sends++;
    out('OK');
  }
}
