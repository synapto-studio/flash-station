// Song moments, the listening half (roadmap R1): can a Pulse tell which song is playing, and where,
// from what its own mic hears? Every 13 ms block the drive already measures the energy in the kick
// band, the snare band and the whole signal (preview-pulse.js stage1, the firmware's own maths).
// Six blocks make a frame (78 ms, about a 16th note at 174 BPM) and each frame becomes 5 bits:
//   bit 0  kick band louder than the frame before       bit 3  balance tipped towards the kick
//   bit 1  snare band louder than the frame before      bit 4  whole signal louder than 2 frames ago
//   bit 2  whole signal louder than the frame before
// A print is the frames of the bars before a moment (what R4 calls "Listen for"), ending at the
// moment. The app makes it by playing the clip through the drive model 16 times (4 rooms; plain,
// reverb, crowd, and another track mixed in under it; 4 frame timings) and keeping only the bits
// that came out the same at least 14 times; the rest are "don't care". The drive compares what it
// just heard with every print, every frame, at 5 speeds (a DJ's pitch, -2 % to +2 %), and fires
// when few enough of the kept bits differ.
//
// FrameMaker and Matcher use whole numbers only, like the firmware: the C version in the firmware
// repo (pulsetest/songmatch/) is checked against them fire for fire.

import { micVolts, stage1, synthDnb } from './preview-pulse.js';

export const BLOCK_SEC = 65 / 5000;        // a detector block: 64 ADC ticks + the one lost to the LEDs
export const FRAME_BLOCKS = 6;
export const FRAME_SEC = FRAME_BLOCKS * BLOCK_SEC;
export const FRAME_BITS = 5;
export const STRETCH = [256, 253, 259, 251, 261]; // x/256: as recorded, 1 % fast, 1 % slow, 2 % fast, 2 % slow
export const RING = 128;                   // frames the drive remembers (10 s)
export const MAX_FRAMES = 120;             // longest print: 9.4 s, 6.8 bars at 174 BPM
export const LIMIT = 41;                   // fire when at most 41/256 (16 %) of the kept bits differ
export const PARTS = 4, PART_LIMIT = 64;   // ...and at most 64/256 (25 %) in each quarter of the print, so a
                                           // loop that matches 3 quarters can't carry a 4th that doesn't
export const MIN_KEPT = 60;                // fewer kept bits than this and a print fires on other music (R1: 1 bar did)
export const TRAIN = { runs: 16, agree: 14, rooms: ['club', 'home', 'rig', 'bar'], leadIn: 12 };

const LOG2_FRAC = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15];
const POP5 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4, 1, 2, 2, 3, 2, 3, 3, 4, 2, 3, 3, 4, 3, 4, 4, 5];

// log2(v) x16, the firmware's way (splX16 without the dB scaling)
export function log2x16(v) {
  if (v < 2) return 0;
  const msb = 31 - Math.clz32(v), norm = (v * 2 ** (31 - msb)) >>> 0;
  return (msb << 4) + LOG2_FRAC[(norm >>> 27) & 15];
}

/* ---------- the drive's side ---------- */
export class FrameMaker {
  constructor() {
    this.sum = [0, 0, 0]; this.n = 0; this.last = [0, 0, 0];
    this.pK = 0; this.pS = 0; this.pA = 0; this.ppA = 0;
  }
  // One block's energies in (µV, from stage1); a frame's 5-bit code out every 6th block, else -1.
  // Blocks the detector marks not ok (just after an auto-range change) repeat the last good one.
  push(eKick, eSnare, eAll, ok) {
    if (ok) this.last = [eKick, eSnare, eAll];
    const e = this.last, s = this.sum;
    s[0] = (s[0] + e[0]) >>> 0; s[1] = (s[1] + e[1]) >>> 0; s[2] = (s[2] + e[2]) >>> 0;
    if (++this.n < FRAME_BLOCKS) return -1;
    const K = log2x16(s[0]), S = log2x16(s[1]), A = log2x16(s[2]);
    const code = (K > this.pK) | (S > this.pS) << 1 | (A > this.pA) << 2 | (K - S > this.pK - this.pS) << 3 | (A > this.ppA) << 4;
    this.ppA = this.pA; this.pK = K; this.pS = S; this.pA = A;
    this.sum = [0, 0, 0]; this.n = 0;
    return code;
  }
}

// A print: frames (W), the bits it expects (value) and which of them count (mask), one byte each per
// frame, oldest first; maxErr = most differing kept bits that still count as a match, partMax = the
// same for each quarter (quarter k = frames from partStart(W, k)).
export const partStart = (W, k) => (k * W + PARTS - 1) >> 2;
export class Matcher {
  constructor(prints) {
    this.prints = prints;
    this.ring = new Uint8Array(RING); this.head = 0; this.count = 0;
    this.lock = new Uint16Array(prints.length);
    this.fm = new FrameMaker();
  }
  // One detector block in; null, or (when a frame completes) the list of prints that fired.
  pushBlock(eKick, eSnare, eAll, ok) {
    const c = this.fm.push(eKick, eSnare, eAll, ok);
    return c < 0 ? null : this.pushFrame(c);
  }
  pushFrame(code) {
    this.head = (this.head + 1) & (RING - 1);
    this.ring[this.head] = code;
    if (this.count < 255) this.count++;
    const fired = [];
    for (let p = 0; p < this.prints.length; p++) {
      if (this.lock[p]) { this.lock[p]--; continue; }
      const s = this.fits(this.prints[p]);
      if (s >= 0) { fired.push({ print: p, stretch: s }); this.lock[p] = this.prints[p].frames; }
    }
    return fired;
  }
  // Index into STRETCH of the first speed the print matches at, or -1.
  fits(pr) {
    const W = pr.frames;
    if (this.count <= (((W - 1) * 261 + 128) >> 8) + 1) return -1;   // not enough heard yet for the slowest speed
                                                                     // (and frame 1 has no "before")
    for (let si = 0; si < STRETCH.length; si++) {
      const s = STRETCH[si];
      let err = 0, acc = 0, i = W - 1, part = PARTS - 1, from = partStart(W, part), perr = 0;
      for (; i >= 0; i--) {
        while (i < from) { from = partStart(W, --part); perr = 0; }
        const code = this.ring[(this.head - ((acc + 128) >> 8)) & (RING - 1)];
        const d = POP5[(code ^ pr.value[i]) & pr.mask[i]];
        err += d; perr += d;
        if (err > pr.maxErr || perr > pr.partMax[part]) break;
        acc += s;
      }
      if (i < 0) return si;
    }
    return -1;
  }
}

/* ---------- the app's side ---------- */
// Frame codes and their end times (s, track time) for a whole stage1 run; `pre` = the run's preroll
export function frameCodes(st, pre = 0, offset = 0) {
  const fm = new FrameMaker(), codes = [], t = [];
  for (let i = 0; i < st.n; i++) {
    const c = fm.push(st.eKick[i], st.eSnare[i], st.eAll[i], st.ok[i]);
    if (c >= 0) { codes.push(c); t.push(st.t[i] - pre + offset); }
  }
  return { codes: Uint8Array.from(codes), t: Float64Array.from(t) };
}

// How far codes[..end] are from a print, over all speeds: `score` = the smallest share of kept bits
// that differ (0 = the same, about 0.5 = unrelated), `match` = whether the drive would fire there.
export function compare(codes, end, pr) {
  let score = 1, match = false;
  for (const s of STRETCH) {
    const perr = new Array(PARTS).fill(0);
    let err = 0, acc = 0, i = pr.frames - 1;
    for (; i >= 0; i--) {
      const j = end - ((acc + 128) >> 8);
      if (j < 1) break;
      const d = POP5[(codes[j] ^ pr.value[i]) & pr.mask[i]];
      err += d; perr[partOf(pr.frames, i)] += d;
      acc += s;
    }
    if (i >= 0) continue;
    score = Math.min(score, err / pr.kept);
    if (err <= pr.maxErr && perr.every((e, k) => e <= pr.partMax[k])) match = true;
  }
  return { score, match };
}
export const score = (codes, end, pr) => compare(codes, end, pr).score;
function partOf(W, i) { let k = PARTS - 1; while (i < partStart(W, k)) k--; return k; }

// Runs a whole recording through a Matcher holding `prints`: every fire, with its time in s.
export function listen(prints, st, pre = 0) {
  const m = new Matcher(prints), out = [];
  for (let i = 0; i < st.n; i++) {
    const f = m.pushBlock(st.eKick[i], st.eSnare[i], st.eAll[i], st.ok[i]);
    if (f) for (const x of f) out.push({ ...x, t: st.t[i] - pre });
  }
  return out;
}

// Learns the print for a moment: `audio` (mono, `rate` Hz), the moment at `playAt` s, listening for
// `listenSec` before it. Returns the print plus `kept` (how many bits count; under MIN_KEPT = too little to learn).
export function trainPrint(audio, rate, playAt, listenSec, opts = {}) {
  const W = Math.round(listenSec / FRAME_SEC), runs = opts.runs || TRAIN.runs, agree = opts.agree || TRAIN.agree;
  if (W < 2 || W > MAX_FRAMES) throw new Error(`Listen for 0.2 to ${(MAX_FRAMES * FRAME_SEC).toFixed(1)} seconds`);
  const from = Math.max(0, playAt - listenSec - TRAIN.leadIn), to = Math.min(audio.length / rate, playAt + 0.5);
  const clip = audio.subarray(Math.floor(from * rate), Math.floor(to * rate));
  const versions = [clip, reverb(clip, rate), withCrowd(clip, rate, 0.25, 555), withTrack(clip, rate, 0.5)];
  const ones = Array.from({ length: W }, () => new Uint8Array(FRAME_BITS));
  for (let v = 0; v < runs; v++) {     // each version in each room, each room at all 4 frame timings
    const room = TRAIN.rooms[v % 4], pre = 1 + ((v + (v >> 2)) % 4) * FRAME_SEC / 4;
    const st = stage1(micVolts(versions[(v >> 2) % 4], rate, room, pre, 101 + v), rate);
    const { codes, t } = frameCodes(st, pre, from);
    let end = 0;
    for (let j = 1; j < t.length; j++) if (Math.abs(t[j] - playAt) < Math.abs(t[end] - playAt)) end = j;
    if (end - W + 1 < 1) throw new Error('The moment is too close to the start of the clip');
    for (let i = 0; i < W; i++) for (let b = 0; b < FRAME_BITS; b++) ones[i][b] += (codes[end - W + 1 + i] >> b) & 1;
  }
  const value = new Uint8Array(W), mask = new Uint8Array(W);
  for (let i = 0; i < W; i++) for (let b = 0; b < FRAME_BITS; b++) {
    const n = ones[i][b];
    if (2 * n > runs) value[i] |= 1 << b;
    if (Math.max(n, runs - n) >= agree) mask[i] |= 1 << b;
  }
  return withLimits({ frames: W, value, mask }, opts.limit, opts.partLimit);
}

// Counts a print's kept bits and sets its limits (whole print and each quarter).
export function withLimits(pr, limit = LIMIT, partLimit = PART_LIMIT) {
  const parts = new Array(PARTS).fill(0);
  for (let i = 0; i < pr.frames; i++) parts[partOf(pr.frames, i)] += POP5[pr.mask[i]];
  const kept = parts.reduce((a, b) => a + b, 0);
  return { ...pr, kept, parts, maxErr: Math.floor(limit * kept / 256), partMax: Uint8Array.from(parts, (n) => Math.min(255, Math.floor(partLimit * n / 256))) };
}

/* ---------- storing a print on the drive ---------- */
// 7 bytes (frames, maxErr low, high, partMax x4), then 10 bits a frame (value, then mask << 5), oldest first.
const HEAD = 3 + PARTS;
export const printBytes = (frames) => HEAD + Math.ceil(frames * 10 / 8);

export function packPrint(pr) {
  const out = new Uint8Array(printBytes(pr.frames));
  out[0] = pr.frames; out[1] = pr.maxErr & 255; out[2] = pr.maxErr >> 8; out.set(pr.partMax, 3);
  for (let i = 0; i < pr.frames; i++) {
    const f = ((pr.value[i] & 31) | (pr.mask[i] & 31) << 5) << (i * 10 & 7), at = HEAD + (i * 10 >> 3);
    out[at] |= f & 255; out[at + 1] |= f >> 8;      // a frame starts at bit 0, 2, 4 or 6: always 2 bytes
  }
  return out;
}

export function unpackPrint(b) {
  const W = b[0], value = new Uint8Array(W), mask = new Uint8Array(W), parts = new Array(PARTS).fill(0);
  for (let i = 0; i < W; i++) {
    const at = HEAD + (i * 10 >> 3), f = ((b[at] | b[at + 1] << 8) >> (i * 10 & 7)) & 1023;
    value[i] = f & 31; mask[i] = f >> 5; parts[partOf(W, i)] += POP5[mask[i]];
  }
  return { frames: W, value, mask, kept: parts.reduce((a, c) => a + c, 0), parts, maxErr: b[1] | b[2] << 8, partMax: b.slice(3, HEAD) };
}

/* ---------- what the app adds when training (the experiment tests with different ones) ---------- */
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
function rand(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }

// A small room's reverb (Schroeder: 4 echoes that fade, 2 smearing stages), mixed 6 dB under the music
export function reverb(x, rate, rt60 = 0.8) {
  const wet = new Float32Array(x.length);
  for (const d of [0.0297, 0.0371, 0.0411, 0.0437]) {
    const n = Math.round(d * rate), g = 10 ** (-3 * d / rt60), buf = new Float32Array(n);
    for (let i = 0, p = 0; i < x.length; i++, p = p + 1 === n ? 0 : p + 1) { const y = buf[p]; buf[p] = x[i] + g * y; wet[i] += y; }
  }
  for (const d of [0.005, 0.0017]) {
    const n = Math.round(d * rate), g = 0.7, buf = new Float32Array(n);
    for (let i = 0, p = 0; i < x.length; i++, p = p + 1 === n ? 0 : p + 1) { const y = -g * wet[i] + buf[p]; buf[p] = wet[i] + g * y; wet[i] = y; }
  }
  const k = 0.5 * rms(x) / (rms(wet) || 1), out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + k * wet[i];
  return out;
}

// People talking: 12 voices that come and go
export function crowd(n, rate, seed = 1) {
  const out = new Float32Array(n), r = rand(seed), hold = Math.round(rate / 40), ease = 32 / rate;
  for (let v = 0; v < 12; v++) {
    const f0 = 150 + r() * 250;
    let ph = r() * 6, lp = 0, bp = 0, env = 0, to = 0;
    for (let i = 0; i < n; i++) {
      if (i % hold === 0) to = r() < 0.6 ? r() : 0;
      env += (to - env) * ease; ph += 2 * Math.PI * f0 / rate;
      const w = r() * 2 - 1; lp += (w - lp) * 0.3; bp += (lp - bp) * 0.05;
      out[i] += env * (0.5 * Math.sin(ph) * (1 + 0.5 * Math.sin(ph * 2.03)) + (lp - bp) * 2);
    }
  }
  return out;
}

// A DJ mix: the demo track under the music, `level` = its loudness against the music's
export function withTrack(x, rate, level) {
  const d = synthDnb(rate, { bars: Math.ceil(x.length / rate / (240 / 174)) + 2, breakFrom: 99 }).audio;
  const g = level * rms(x) / (rms(d) || 1), out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + g * d[i];
  return out;
}

// A crowd over the music, `level` = its loudness against the music's
export function withCrowd(x, rate, level, seed) {
  const c = crowd(x.length, rate, seed), g = level * rms(x) / (rms(c) || 1), out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + g * c[i];
  return out;
}
