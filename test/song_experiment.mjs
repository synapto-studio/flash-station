// Roadmap R1: the song recognition experiment, on real clips. Not part of `npm test` (clips are never
// committed). Needs ffmpeg. Usage:
//   node test/song_experiment.mjs "Poison.mp3@1:28" "touchdown.mp3@1:06@174" [--bars 1,2,3,4,6]
// Each clip is "file@moment[@bpm]" (bpm defaults to 174). For every listening length it learns each
// moment's print (js/songs.js trainPrint), then plays every clip, the demo track and room noise to a
// simulated drive holding all the prints, in rooms and conditions the training never used, and
// prints Markdown tables: found at the right place / wrong song / missed, and how close it was.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import * as P from '../js/preview-pulse.js';
import { trainPrint, listen, frameCodes, score, printBytes, packPrint, crowd, FRAME_SEC, RING, LIMIT } from '../js/songs.js';

const RATE = 16000;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args.splice(i, 2)[1]; };
const BARS = opt('--bars', '1,2,3,4,6').split(',').map(Number);
const limit = +opt('--limit', LIMIT);
if (!args.length) { console.error('Give at least one clip: "file.mp3@1:28"'); process.exit(1); }
const mmss = (s) => { const [m, x] = s.split(':').map(Number); return x === undefined ? m : m * 60 + x; };
const fmt = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${(Math.abs(t) % 60).toFixed(1).padStart(4, '0')}`;
const some = (list, n = 3) => list.length <= n ? list.join(', ') : `${list.length} times, e.g. ${list.slice(0, n).join(', ')}`;

/* ---------- clips ---------- */
const tmp = mkdtempSync(join(tmpdir(), 'synapto-r1-'));
const clips = args.map((a) => {
  const [file, at, bpm] = a.split('@');
  const out = join(tmp, basename(file) + '.f32');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', out]);
  const b = readFileSync(out);
  const name = basename(file).replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, '').replace(/_/g, ' ').replace(/ +/g, ' ');
  return { name, audio: new Float32Array(b.buffer, b.byteOffset, b.length / 4), moment: mmss(at), bpm: +(bpm || 174) };
});
rmSync(tmp, { recursive: true, force: true });

/* ---------- test conditions (none of these are used in training) ---------- */
function rms(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }
function rand(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; }
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
// A club's reverb: a dense 1.2 s tail of decaying noise (not the trainer's echo model), 6 dB under the music
function clubReverb(x, rt60 = 1.2, seed = 5) {
  const L = Math.floor(rt60 * RATE), r = rand(seed), ir = new Float64Array(L);
  let e = 0;
  for (let i = 0; i < L; i++) { ir[i] = (r() * 2 - 1) * 10 ** (-3 * i / L); e += ir[i] * ir[i]; }
  for (let i = 0; i < L; i++) ir[i] *= 0.5 / Math.sqrt(e);
  ir[0] += 1;
  const N = 65536, hop = N - L, hr = new Float64Array(N), hi = new Float64Array(N);
  hr.set(ir); fft(hr, hi, false);
  const out = new Float32Array(x.length);
  for (let s = 0; s < x.length; s += hop) {
    const br = new Float64Array(N), bi = new Float64Array(N);
    br.set(x.subarray(s, Math.min(x.length, s + hop))); fft(br, bi, false);
    for (let k = 0; k < N; k++) { const a = br[k] * hr[k] - bi[k] * hi[k]; bi[k] = br[k] * hi[k] + bi[k] * hr[k]; br[k] = a; }
    fft(br, bi, true);
    for (let k = 0; k < N && s + k < x.length; k++) out[s + k] += br[k];
  }
  return out;
}
// A louder crowd than the trainer's: other voices, plus hiss and a cheer every 8 s or so
function testCrowd(n, seed) {
  const out = crowd(n, RATE, seed), r = rand(seed + 1);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) { const w = r() * 2 - 1; b0 = 0.997 * b0 + w * 0.03; b1 = 0.96 * b1 + w * 0.06; b2 = 0.6 * b2 + w * 0.1; out[i] += 0.3 * (b0 + b1 + b2); }
  for (let c = 0; c < n / RATE / 8; c++) {
    const s = Math.floor(r() * (n - RATE * 2));
    for (let i = 0; i < RATE * 2; i++) out[s + i] += 1.5 * Math.sin(Math.PI * i / (RATE * 2)) * (r() * 2 - 1);
  }
  return out;
}
function mixCrowd(x, snrDb, seed) {
  const c = testCrowd(x.length, seed), g = rms(x) / rms(c) * 10 ** (-snrDb / 20), y = Float32Array.from(x);
  for (let i = 0; i < y.length; i++) y[i] += g * c[i];
  return y;
}
function speed(x, f) {   // the DJ's pitch: plays f times as fast (tempo and pitch, like a CDJ without key lock)
  const n = Math.floor((x.length - 1) / f), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * f, j = Math.floor(p), a = p - j; y[i] = x[j] * (1 - a) + x[j + 1] * a; }
  return y;
}
const CONDITIONS = [
  { id: 'club', label: 'Club, fresh noise', room: 'club', make: (x) => x },
  { id: 'home', label: 'Home (80 dB)', room: 'home', make: (x) => x },
  { id: 'bar', label: 'Bar (88 dB)', room: 'bar', make: (x) => x },
  { id: 'rig', label: 'Big rig (104 dB)', room: 'rig', make: (x) => x },
  { id: 'crowd10', label: 'Crowd 10 dB under the music', room: 'club', make: (x, s) => mixCrowd(x, 10, s) },
  { id: 'crowd3', label: 'Crowd 3 dB under the music', room: 'club', make: (x, s) => mixCrowd(x, 3, s) },
  { id: 'reverb', label: 'Reverb 1.2 s', room: 'club', make: (x) => clubReverb(x) },
  { id: 'fast1', label: 'DJ pitch +1 %', room: 'club', make: (x) => speed(x, 1.01), f: 1.01 },
  { id: 'slow1', label: 'DJ pitch -1 %', room: 'club', make: (x) => speed(x, 0.99), f: 0.99 },
  { id: 'fast2', label: 'DJ pitch +2 %', room: 'club', make: (x) => speed(x, 1.02), f: 1.02 },
  { id: 'slow2', label: 'DJ pitch -2 %', room: 'club', make: (x) => speed(x, 0.98), f: 0.98 },
  { id: 'late', label: 'Plugged in 2.6 s early, track 0.14 s in', room: 'club', make: (x) => x.subarray(Math.round(0.137 * RATE)), shift: 0.137, pre: 2.6 },
  { id: 'mixed', label: 'DJ mix: another track 6 dB under it', room: 'club', make: (x, s, other) => mixIn(x, other, 0.5) },
];
function mixIn(x, other, gain) {   // the other track (or the demo), started 20.3 s in so the beats don't line up
  const y = Float32Array.from(x), off = Math.round(20.3 * RATE), g = gain * rms(x) / rms(other);
  for (let i = 0; i < y.length; i++) y[i] += g * other[(i + off) % other.length];
  return y;
}

function hear(audio, room, seed, pre = 1) {
  const st = P.stage1(P.micVolts(audio, RATE, room, pre, seed), RATE);
  return { st, pre, codes: frameCodes(st, pre) };
}
console.error(`Simulating ${clips.length} clips x ${CONDITIONS.length} conditions...`);
const recs = [];   // every recording the drive hears
const demo = P.synthDnb(RATE, { bars: 40 }).audio, noise = testCrowd(RATE * 60, 77);
clips.forEach((c, ci) => CONDITIONS.forEach((k, ki) => {
  const other = clips.length > 1 ? clips[(ci + 1) % clips.length].audio : demo;
  const h = hear(k.make(c.audio, 900 + ki, other), k.room, 11 + 6 * ki + ci, k.pre || 1);
  recs.push({ ...h, clip: ci, cond: k, at: (c.moment - (k.shift || 0)) / (k.f || 1), name: `${c.name}, ${k.label}` });
}));
recs.push({ ...hear(demo, 'club', 201), clip: -1, name: 'Demo track (174 BPM), club' });
recs.push({ ...hear(demo, 'rig', 202), clip: -1, name: 'Demo track (174 BPM), big rig' });
recs.push({ ...hear(noise, 'bar', 203), clip: -1, name: 'Crowd, no music, bar' });
recs.push({ ...hear(noise, 'club', 204), clip: -1, name: 'Crowd, no music, club' });
recs.push({ ...hear(new Float32Array(RATE * 30), 'silence', 205), clip: -1, name: 'Quiet room' });

/* ---------- learn, listen, report ---------- */
const results = [];
for (const bars of BARS) {
  console.error(`Listening for ${bars} bar(s)...`);
  const prints = clips.map((c) => trainPrint(c.audio, RATE, c.moment, bars * 240 / c.bpm, { limit }));
  const fires = recs.map((r) => listen(prints, r.st, r.pre));
  results.push({ bars, prints, fires });
}

console.log(`# R1 results\n\nPrints keep bits that 14 of 16 training runs agree on; a match is at most ${limit}/256 (${(limit / 2.56).toFixed(0)} %) of them differing. "Right place" = within 1 beat of the moment. Scores: share of kept bits that differ (0 = identical).\n`);
for (const [ci, c] of clips.entries()) {
  const beat = 60 / c.bpm;
  console.log(`## ${c.name} @ ${fmt(c.moment)} (${c.bpm} BPM)\n`);
  console.log('| Listen for | Found at the right place | Timing (worst) | Also fired in the same song | Fired on another song, the demo or noise | Worst score at the moment | Closest score elsewhere (same song / other) | Print size |');
  console.log('|---|---|---|---|---|---|---|---|');
  const detail = {};
  for (const { bars, prints, fires } of results) {
    const pr = prints[ci];
    let found = 0, worstErr = 0, worstAt = 0, bestSame = 1, bestOther = 1;
    const same = {}, wrong = [], rows = [];
    recs.forEach((r, ri) => {
      const mine = fires[ri].filter((f) => f.print === ci);
      const { codes, t } = r.codes;
      if (r.clip === ci) {
        const hit = mine.find((f) => Math.abs(f.t - r.at) <= beat);
        let sAt = 1;
        for (let j = 1; j < t.length; j++) {
          const s = score(codes, j, pr);
          if (Math.abs(t[j] - r.at) <= beat) sAt = Math.min(sAt, s); else bestSame = Math.min(bestSame, s);
        }
        worstAt = Math.max(worstAt, sAt);
        if (hit) { found++; worstErr = Math.max(worstErr, Math.abs(hit.t - r.at)); }
        for (const f of mine) if (f !== hit) { const k = fmt(f.t * (r.cond.f || 1) + (r.cond.shift || 0)).replace(/\.\d$/, ''); same[k] = (same[k] || 0) + 1; }
        rows.push(`| ${r.cond.label} | ${hit ? `${fmt(hit.t)} (${((hit.t - r.at) * 1000).toFixed(0)} ms)` : 'missed'} | ${sAt.toFixed(2)} |`);
      } else {
        for (const f of mine) wrong.push(`${r.name} ${fmt(f.t)}`);
        for (let j = 1; j < t.length; j++) bestOther = Math.min(bestOther, score(codes, j, pr));
      }
    });
    detail[bars] = rows;
    const sameList = Object.entries(same).sort((a, b) => b[1] - a[1]), sameTxt = !sameList.length ? 'no'
      : sameList.length <= 3 ? sameList.map(([k, n]) => `${k} (in ${n} of ${CONDITIONS.length} conditions)`).join(', ')
      : `${sameList.length} places, e.g. ${sameList.slice(0, 3).map(([k, n]) => `${k} (${n} of ${CONDITIONS.length})`).join(', ')}`;
    console.log(`| ${bars} bar${bars > 1 ? 's' : ''} (${(pr.frames * FRAME_SEC).toFixed(1)} s, ${pr.kept} bits kept) | ${found} of ${CONDITIONS.length} | ${found ? `${(worstErr * 1000).toFixed(0)} ms` : '-'} | ${sameTxt} | ${wrong.length ? some(wrong) : 'none'} | ${worstAt.toFixed(2)} | ${bestSame.toFixed(2)} / ${bestOther.toFixed(2)} | ${packPrint(pr).length} bytes |`);
  }
  const need = results.find(({ bars, fires }) => recs.every((r, ri) => {
    const mine = fires[ri].filter((f) => f.print === ci);
    return r.clip === ci ? mine.some((f) => Math.abs(f.t - r.at) <= beat) : !mine.length;
  }));
  console.log(`\nBars of listening needed: ${need ? `**${need.bars}** (found in every condition, never fired on another song, the demo or noise)` : '**not reached** in the lengths tried'}.\n`);
  const show = need ? need.bars : BARS[BARS.length - 1];
  console.log(`Each condition at ${show} bar${show > 1 ? 's' : ''}:\n\n| Condition | Fired at (vs the moment) | Score at the moment |\n|---|---|---|\n${detail[show].join('\n')}\n`);
}
const maxFrames = Math.max(...results.map((r) => Math.max(...r.prints.map((p) => p.frames))));
console.log(`## Size\n\nA print is ${printBytes(Math.round(4 * 240 / 174 / FRAME_SEC))} bytes for 4 bars at 174 BPM (7 bytes + 10 bits a frame; longest tried here: ${maxFrames} frames, ${printBytes(maxFrames)} bytes). The drive keeps the last ${RING} frames; with its sums and state the matcher needs 182 bytes of RAM (measured: firmware repo pulsetest/songmatch/build.sh).`);
