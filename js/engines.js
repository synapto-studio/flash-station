// Engines (the firmware on the drive's chip) and their settings blocks.
//
//   coretest  (was Motor Start) Core, ATtiny412, settings block tagged SOTA.LED
//   pulsetest (was Rise)        Pulse, ATtiny1614, bootloader + routine, settings page SOTA.PLS
//   Beat                        Pulse, ATtiny1614, older engine, settings block SOTA.MIC
//
// A .hex file is recognised by the tag inside it, so file names don't matter. Settings are
// changed by rewriting the tagged block in the file before flashing: no compiler needed.

import { slice, flashEnd, indexOf, HEX_BASE } from './intelhex.js';
import { crc16 } from './crc.js';

// ---------------------------------------------------------------- settings layouts
// [name, type, phase, label]. Types: u8 i8 u16 u32 rgb tag cranks. Order and types must
// match the struct in the firmware exactly (AVR structs have no padding).
export const LAYOUTS = {
  'SOTA.LED': [
    ['tag', 'tag'], ['layout', 'u8'],
    ['brightness', 'u8', 'shared', 'Overall brightness (0–255)'],
    ['white', 'rgb', 'shared', 'White'], ['red', 'rgb', 'shared', 'Red'],
    ['orange', 'rgb', 'shared', 'Orange'], ['yellow', 'rgb', 'shared', 'Yellow'],
    ['startupDim', 'u8', 'loadup', 'How dim the outer LEDs start (0–255)'],
    ['whiteMs', 'u32', 'loadup', 'White glow at power-on (ms)'],
    ['whiteToRedMs', 'u32', 'loadup', 'White to red fade (ms)'],
    ['colourStepMs', 'u32', 'standard', 'Each colour fade in the loop (ms)'],
    ['catchMs', 'u32', 'loadup', 'Motor catches and revs up (ms)'],
    ['catchFrom', 'u8', 'loadup', 'Rev-up starts from (0–255)'],
    ['breatheMs', 'u32', 'standard', 'One full breath, inner LEDs (ms)'],
    ['breatheMin', 'u8', 'standard', 'Dimmest point of the breath (0–255)'],
    ['numCranks', 'u8', 'loadup', 'Cranks used'],
    ['cranks', 'cranks', 'loadup', 'Motor cranks (on ms, off ms, peak)'],
  ],
  'SOTA.PLS': [
    ['tag', 'tag'], ['layout', 'u8'],
    ['brightness', 'u8', 'shared', 'Overall brightness (0–255)'],
    ['white', 'rgb', 'shared', 'White'], ['red', 'rgb', 'shared', 'Red'], ['orange', 'rgb', 'shared', 'Orange'],
    ['riseMs', 'u16', 'loadup', 'White glow rises bottom to top (ms)'],
    ['topPulseMs', 'u16', 'loadup', 'Top pulses white (ms)'],
    ['multiMs', 'u16', 'loadup', 'Top goes multicoloured (ms)'],
    ['pourMs', 'u16', 'loadup', 'Colours pour down (ms)'],
    ['whiteMs', 'u16', 'loadup', 'Everything fades to white (ms)'],
    ['drainMs', 'u16', 'loadup', 'White drains into the plug (ms)'],
    ['flowMs', 'u16', 'loadup', 'Red flows up out of the plug (ms)'],
    ['topPulses', 'u8', 'loadup', 'White pulses at the top'],
    ['glowLevel', 'u8', 'loadup', 'Rising glow brightness (0–255)'],
    ['bottomLevel', 'u8', 'standard', 'Bottom red–orange brightness (0–255)'],
    ['middleLevel', 'u8', 'standard', 'Middle dim red brightness (0–255)'],
    ['topHigh', 'u8', 'standard', 'Top pulse brightest (0–255)'],
    ['topLow', 'u8', 'standard', 'Top pulse dimmest (0–255)'],
    ['cycleBars', 'u8', 'standard', 'Bars per bottom colour cycle'],
    ['bpmX10', 'u16', 'standard', 'Starting tempo × 10 (1740 = 174 BPM)'],
    ['bpmMin', 'u8', 'beat', 'Slowest tempo it locks to (BPM)'],
    ['bpmMax', 'u8', 'beat', 'Fastest tempo it locks to (BPM)'],
    ['leadMs', 'u8', 'beat', 'Show the pulse this early (ms)'],
    ['micTrimDb', 'i8', 'beat', 'Mic calibration (dB)'],
    ['loudTop', 'u8', 'beat', 'Top reacts from (dB SPL)'],
    ['loudMiddle', 'u8', 'beat', 'Middle joins in from (dB SPL)'],
    ['loudBottom', 'u8', 'beat', 'Bottom joins in from (dB SPL)'],
    ['kickFadeMs', 'u16', 'beat', 'Surge fade (ms)'],
    ['kickMin', 'u8', 'beat', 'Surge for the smallest kicks (0–255)'],
    ['kickJumpX10', 'u8', 'beat', 'Kick: jump needed (tenths)'],
    ['kickLoudX10', 'u8', 'beat', 'Kick: loud next to the music (tenths)'],
    ['kickMinPct', 'u8', 'beat', 'Kick: size vs recent kicks (%)'],
    ['kickFloorUv', 'u16', 'beat', 'Kick: minimum level (µV)'],
    ['kickGapMs', 'u16', 'beat', 'Shortest gap between kicks (ms)'],
    ['snareJumpX10', 'u8', 'beat', 'Snare: jump needed (tenths)'],
    ['snareLoudX10', 'u8', 'beat', 'Snare: loud next to the music (tenths)'],
    ['snareMinPct', 'u8', 'beat', 'Snare: size vs recent snares (%)'],
    ['snareFloorUv', 'u16', 'beat', 'Snare: minimum level (µV)'],
  ],
  'SOTA.MIC': [
    ['tag', 'tag'], ['layout', 'u8'],
    ['brightness', 'u8', 'shared', 'Overall brightness (0–255)'],
    ['red', 'rgb', 'shared', 'Red'], ['orange', 'rgb', 'shared', 'Orange'],
    ['amber', 'rgb', 'shared', 'Kick colour'], ['white', 'rgb', 'shared', 'Snare colour'],
    ['breatheMs', 'u32', 'standard', 'One full breath (ms)'],
    ['idleMin', 'u8', 'standard', 'Breathing low, no music'], ['idleMax', 'u8', 'standard', 'Breathing high, no music'],
    ['musicBase', 'u8', 'beat', 'Background glow with music'], ['musicHoldMs', 'u16', 'beat', 'Back to idle after (ms)'],
    ['kickFadeMs', 'u16', 'beat', 'Kick fade (ms)'], ['kickMin', 'u8', 'beat', 'Smallest kick pulse'],
    ['snaresOn', 'u8', 'beat', 'Snares on (1) or off (0)'], ['snareFadeMs', 'u16', 'beat', 'Snare fade (ms)'],
    ['snareWhite', 'u8', 'beat', 'Snare towards white'], ['snareLeds', 'u8', 'beat', 'Snare LEDs (bit mask)'],
    ['kickJumpX10', 'u8', 'beat', 'Kick: jump needed'], ['kickLoudX10', 'u8', 'beat', 'Kick: loud next to music'],
    ['kickMinPct', 'u8', 'beat', 'Kick: size vs recent'], ['kickFloorUv', 'u16', 'beat', 'Kick: minimum level (µV)'],
    ['snareJumpX10', 'u8', 'beat', 'Snare: jump needed'], ['snareLoudX10', 'u8', 'beat', 'Snare: loud next to music'],
    ['snareMinPct', 'u8', 'beat', 'Snare: size vs recent'], ['snareFloorUv', 'u16', 'beat', 'Snare: minimum level (µV)'],
    ['kickGapMs', 'u16', 'beat', 'Shortest gap between kicks (ms)'], ['snareGapMs', 'u16', 'beat', 'Shortest gap between snares (ms)'],
  ],
};

const SIZE = { u8: 1, i8: 1, u16: 2, u32: 4, rgb: 3, tag: 8, cranks: 60 };
export const layoutSize = (tag) => LAYOUTS[tag].reduce((n, [, t]) => n + SIZE[t], 0);

export function unpackSettings(tag, bytes) {
  const out = {};
  let o = 0;
  const u16 = (i) => bytes[i] | (bytes[i + 1] << 8);
  for (const [name, type] of LAYOUTS[tag]) {
    if (type === 'u8') out[name] = bytes[o];
    else if (type === 'i8') out[name] = (bytes[o] << 24) >> 24;
    else if (type === 'u16') out[name] = u16(o);
    else if (type === 'u32') out[name] = (u16(o) + u16(o + 2) * 65536) >>> 0;
    else if (type === 'rgb') out[name] = [bytes[o], bytes[o + 1], bytes[o + 2]];
    else if (type === 'tag') out[name] = String.fromCharCode(...bytes.subarray(o, o + 8));
    else if (type === 'cranks') {
      out[name] = [];
      for (let i = 0; i < 12; i++) {
        const p = o + i * 5;
        out[name].push([u16(p), u16(p + 2), bytes[p + 4]]);
      }
    }
    o += SIZE[type];
  }
  return out;
}

export function packSettings(tag, s) {
  const out = new Uint8Array(layoutSize(tag));
  let o = 0;
  const range = (name, v, lo, hi) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be a whole number ${lo}–${hi} (got ${v})`);
    return v;
  };
  const put16 = (i, v) => {
    out[i] = v & 0xff;
    out[i + 1] = (v >> 8) & 0xff;
  };
  for (const [name, type] of LAYOUTS[tag]) {
    const v = s[name];
    if (type === 'u8') out[o] = range(name, v, 0, 255);
    else if (type === 'i8') out[o] = range(name, v, -128, 127) & 0xff;
    else if (type === 'u16') put16(o, range(name, v, 0, 65535));
    else if (type === 'u32') {
      range(name, v, 0, 0xffffffff);
      put16(o, v & 0xffff);
      put16(o + 2, Math.floor(v / 65536));
    } else if (type === 'rgb') {
      if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} needs three numbers 0–255`);
      v.forEach((c, i) => (out[o + i] = range(name, c, 0, 255)));
    } else if (type === 'tag') {
      if (v !== tag) throw new Error(`Settings are for ${v}, not ${tag}`);
      for (let i = 0; i < 8; i++) out[o + i] = v.charCodeAt(i);
    } else if (type === 'cranks') {
      for (let i = 0; i < 12; i++) {
        const [on, off, peak] = v[i] || [0, 0, 0];
        put16(o + i * 5, range(name, on, 0, 65535));
        put16(o + i * 5 + 2, range(name, off, 0, 65535));
        out[o + i * 5 + 4] = range(name, peak, 0, 255);
      }
    }
    o += SIZE[type];
  }
  return out;
}

export function fieldsForPhase(tag, phase) {
  return LAYOUTS[tag].filter((f) => f[2] === phase).map((f) => f[0]);
}

// ---------------------------------------------------------------- pulsetest image
// Port of the Image class in the Pi tool (station/pulse_station.py), byte for byte.
export const PULSE = {
  APP_START: 0x0c00,
  PAGE: 64,
  APP_PAGES: 208,
  TRAILER_PAGE: 207,
  get APP_MAX() {
    return this.TRAILER_PAGE * this.PAGE;
  },
  BOOTEND: 0x0c,
};

export class PulseImage {
  constructor(app, version = [1, 0], settings = null) {
    this.app = Uint8Array.from(app);
    const i = indexOf(this.app, 'SOTA.PLS');
    if (i < 0 || i % PULSE.PAGE) throw new Error('No page-aligned SOTA.PLS settings block in this routine.');
    this.setPage = i / PULSE.PAGE;
    if (settings) this.app.set(packSettings('SOTA.PLS', settings), i);
    if (this.app.length > PULSE.APP_MAX) throw new Error(`Routine is ${this.app.length} bytes: too big (max ${PULSE.APP_MAX}).`);
    this.version = version;
    this.trailer = this.makeTrailer();
  }

  get settings() {
    const i = this.setPage * PULSE.PAGE;
    return unpackSettings('SOTA.PLS', this.app.subarray(i, i + 64));
  }

  codeCrc() {
    const i = this.setPage * PULSE.PAGE;
    const rest = new Uint8Array(this.app.length - PULSE.PAGE);
    rest.set(this.app.subarray(0, i));
    rest.set(this.app.subarray(i + PULSE.PAGE), i);
    return crc16(rest);
  }

  makeTrailer() {
    const t = new Uint8Array(PULSE.PAGE).fill(0xff);
    t.set([0x53, 0x50, 0x4c, 0x31]); // "SPL1"
    const put16 = (o, v) => ((t[o] = v & 0xff), (t[o + 1] = v >> 8));
    put16(4, this.app.length);
    put16(6, crc16(this.app));
    put16(8, this.codeCrc());
    t[10] = this.setPage;
    t[11] = this.version[0];
    t[12] = this.version[1];
    put16(62, crc16(t.subarray(0, 62)));
    return t;
  }

  // [page index, 64 bytes] for every routine page, then the trailer (what `update` sends).
  pages() {
    const out = [];
    for (let p = 0; p * PULSE.PAGE < this.app.length; p++) {
      const d = new Uint8Array(PULSE.PAGE).fill(0xff);
      d.set(this.app.subarray(p * PULSE.PAGE, (p + 1) * PULSE.PAGE));
      out.push([p, d]);
    }
    out.push([PULSE.TRAILER_PAGE, this.trailer]);
    return out;
  }

  imageId() {
    const all = new Uint8Array(this.app.length + PULSE.PAGE);
    all.set(this.app);
    all.set(this.trailer, this.app.length);
    return crc16(all);
  }
}

// ---------------------------------------------------------------- reading engine files
export function readEngine(mem, fileName = '') {
  const end = flashEnd(mem);
  const flash = slice(mem, 0, end);
  const fv = /(\d+)[._](\d+)/.exec(fileName);
  const fileVersion = fv ? [Number(fv[1]), Number(fv[2])] : null;
  const pls = indexOf(flash, 'SOTA.PLS');
  const led = indexOf(flash, 'SOTA.LED');
  const mic = indexOf(flash, 'SOTA.MIC');

  if (pls >= 0) {
    const { APP_START, APP_MAX } = PULSE;
    const tAddr = APP_START + PULSE.TRAILER_PAGE * PULSE.PAGE;
    const trailer = slice(mem, tAddr, tAddr + PULSE.PAGE);
    const hasTrailer = String.fromCharCode(...trailer.subarray(0, 4)) === 'SPL1';
    // The trailer records the routine's exact length; without one, the file's extent does.
    let appEnd = APP_START;
    if (hasTrailer && (trailer[4] | (trailer[5] << 8)) <= APP_MAX) appEnd = APP_START + (trailer[4] | (trailer[5] << 8));
    else for (const a of mem.keys()) if (a >= APP_START && a < APP_START + APP_MAX && a + 1 > appEnd) appEnd = a + 1;
    const app = slice(mem, APP_START, appEnd);
    const boot = slice(mem, 0, APP_START);
    const hasBoot = [...mem.keys()].some((a) => a < APP_START && mem.get(a) !== 0xff);
    const version = hasTrailer ? [trailer[11], trailer[12]] : fileVersion || [1, 0];
    const img = new PulseImage(app, version);
    return {
      kind: 'pulsetest',
      family: 'pulse',
      chip: 'attiny1614',
      tag: 'SOTA.PLS',
      version,
      label: `pulsetest ${version.join('.')}`,
      hasBootloader: hasBoot,
      boot,
      app,
      defaults: img.settings,
      fileName,
    };
  }
  if (led >= 0) {
    const tagged = slice(mem, led, led + layoutSize('SOTA.LED'));
    const clock = /10\s*mhz/i.test(fileName) ? 10 : /20\s*mhz/i.test(fileName) ? 20 : null;
    const version = fileVersion || null;
    return {
      kind: 'coretest',
      family: 'core',
      chip: 'attiny412',
      tag: 'SOTA.LED',
      version,
      clock,
      label: `coretest ${version ? version.join('.') : ''}${clock ? ` · ${clock} MHz` : ''}`.replace('  ', ' '),
      flash,
      settingsOffset: led,
      defaults: unpackSettings('SOTA.LED', tagged),
      fileName,
    };
  }
  if (mic >= 0) {
    const version = fileVersion || null;
    return {
      kind: 'beat',
      family: 'pulse',
      chip: 'attiny1614',
      tag: 'SOTA.MIC',
      version,
      label: `Beat ${version ? version.join('.') : ''}`.trim(),
      flash,
      settingsOffset: mic,
      defaults: unpackSettings('SOTA.MIC', slice(mem, mic, mic + layoutSize('SOTA.MIC'))),
      fileName,
    };
  }
  return { kind: 'unknown', family: null, label: 'Unknown firmware', fileName };
}

// What the Initialisation Station writes: flash bytes from address 0, and the BOOTEND fuse.
export function buildInitImage(engine, settings = null) {
  if (engine.kind === 'pulsetest') {
    if (!engine.hasBootloader) {
      throw new Error('This pulsetest file has no bootloader in it. Use the "_full.hex" file for initialising.');
    }
    const img = new PulseImage(engine.app, engine.version, settings);
    const flash = new Uint8Array(0x4000).fill(0xff);
    flash.set(engine.boot, 0);
    flash.set(img.app, PULSE.APP_START);
    flash.set(img.trailer, PULSE.APP_START + PULSE.TRAILER_PAGE * PULSE.PAGE);
    return { flash, bootend: PULSE.BOOTEND, imageId: img.imageId(), settings: img.settings };
  }
  if (engine.kind === 'coretest' || engine.kind === 'beat') {
    const flash = Uint8Array.from(engine.flash);
    if (settings) flash.set(packSettings(engine.tag, settings), engine.settingsOffset);
    const at = engine.settingsOffset;
    return {
      flash,
      bootend: 0x00,
      imageId: crc16(flash),
      settings: unpackSettings(engine.tag, flash.subarray(at, at + layoutSize(engine.tag))),
    };
  }
  throw new Error("This file isn't a coretest, pulsetest or Beat engine.");
}

// A .hex of exactly what the IS writes, for the Terminal fallback (pymcuprog write).
export function initImageToMem(image) {
  const mem = new Map();
  image.flash.forEach((b, a) => {
    const page = a & ~63;
    if (image.flash.subarray(page, page + 64).some((x) => x !== 0xff)) mem.set(a, b);
  });
  mem.set(HEX_BASE.fuses + 8, image.bootend);
  return mem;
}
