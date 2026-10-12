// Intel HEX files, as made by Arduino/avr-gcc and pymcuprog. Memory beyond flash uses
// pymcuprog's offsets: EEPROM 0x810000, fuses 0x820000, lock 0x830000, user row 0x850000.

export const HEX_BASE = { eeprom: 0x810000, fuses: 0x820000, lockbits: 0x830000, userRow: 0x850000 };

export function parseHex(text) {
  const mem = new Map();
  let base = 0;
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    line++;
    const s = raw.trim();
    if (!s) continue;
    if (s[0] !== ':') throw new Error(`Line ${line} isn't Intel HEX`);
    const bytes = [];
    for (let i = 1; i < s.length; i += 2) bytes.push(parseInt(s.slice(i, i + 2), 16));
    if (bytes.some(Number.isNaN)) throw new Error(`Line ${line} has a bad character`);
    const [n, ah, al, type] = bytes;
    if (bytes.length !== n + 5) throw new Error(`Line ${line} is the wrong length`);
    if (bytes.reduce((a, b) => a + b, 0) & 0xff) throw new Error(`Line ${line} has a bad checksum`);
    const data = bytes.slice(4, 4 + n);
    if (type === 0) data.forEach((b, i) => mem.set(base + ((ah << 8) | al) + i, b));
    else if (type === 1) break;
    else if (type === 2) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 4) base = ((data[0] << 8) | data[1]) << 16;
  }
  return mem;
}

export function toHex(mem) {
  const addrs = [...mem.keys()].sort((a, b) => a - b);
  const lines = [];
  const rec = (bytes) => {
    const sum = bytes.reduce((a, b) => a + b, 0);
    return ':' + [...bytes, -sum & 0xff].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  let upper = -1;
  for (let i = 0; i < addrs.length; ) {
    const a = addrs[i];
    if (a >>> 16 !== upper) {
      upper = a >>> 16;
      lines.push(rec([2, 0, 0, 4, upper >> 8, upper & 0xff]));
    }
    const chunk = [mem.get(a)];
    while (chunk.length < 16 && i + chunk.length < addrs.length && addrs[i + chunk.length] === a + chunk.length && (a + chunk.length) >>> 16 === upper) {
      chunk.push(mem.get(a + chunk.length));
    }
    lines.push(rec([chunk.length, (a >> 8) & 0xff, a & 0xff, 0, ...chunk]));
    i += chunk.length;
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

// Bytes from start (inclusive) to end (exclusive), 0xFF where the file has nothing.
export function slice(mem, start, end) {
  const out = new Uint8Array(end - start).fill(0xff);
  for (const [a, b] of mem) if (a >= start && a < end) out[a - start] = b;
  return out;
}

export function flashEnd(mem) {
  let end = 0;
  for (const a of mem.keys()) if (a < 0x800000 && a + 1 > end) end = a + 1;
  return end;
}

export function indexOf(bytes, text) {
  const t = Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = 0; i + t.length <= bytes.length; i++) {
    for (let j = 0; j < t.length; j++) if (bytes[i + j] !== t[j]) continue outer;
    return i;
  }
  return -1;
}
