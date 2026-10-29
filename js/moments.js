// Song moments (roadmap R4): a part of a song a Pulse recognises, and the animation it plays
// there. The screen is js/moments-tab.js; the listening maths is js/songs.js (R1).
//
// A moment has two marks on the song:
//   Listen for: the bars the drive learns (default 4, at least 3). When they end, the drive has
//               heard enough to say "this is the moment": that's "recognised by here".
//   Play at:    when the animation starts. On a beat, and never before the drive can recognise it.
// The drive fires at the end of listening, waits (Play at - end of listening), then plays.
//
// This file is plain maths with no screen, so the tests can run it: the song's beat grid, where
// the marks may go, learning and checking a moment through the simulated mic, the moment file,
// and what the drive does when it hears a song.

import { micVolts, stage1 } from './preview-pulse.js';
import { trainPrint, listen, packPrint, unpackPrint, FRAME_SEC, MAX_FRAMES, MIN_KEPT } from './songs.js';

export const RATE = 16000;            // what clips are learnt at (R1: train at 16 kHz)
export const LISTEN_BARS = { min: 3, start: 4, max: 6 };
export const BEFORE_PLAY = 0.5;       // beats: listening ends this far before Play at when it's placed for you
export const MARGIN = 0.06;           // s: the drive fired up to 52 ms off in R1, so Play at stays this far after
// How a moment is checked: 8 hearings, 4 rooms with 2 frame timings each (training used other noise).
// The drive has to recognise it in at least 7 of them.
export const HEARINGS = ['club', 'home', 'rig', 'bar'].flatMap((room, i) => [{ room, pre: 1, seed: 900 + i }, { room, pre: 1 + FRAME_SEC / 2, seed: 910 + i }]);
export const MUST_HEAR = 7;
export const AUDIO_TYPES = /\.(mp3|wav|m4a|aac|aiff?|flac|ogg)$/i;

/* ---------- the beat grid ---------- */
// The song's tempo and where bar 1 starts, found from its kicks and snares. Real tracks keep one
// tempo, so one grid fits the whole song: { bpm, firstBar } (s, the first downbeat at or after 0).
export function beatGrid(audio, rate, { minBpm = 100, maxBpm = 200 } = {}) {
  const hop = Math.round(rate / 100), n = Math.floor(audio.length / hop);   // 10 ms frames
  if (n < 400) throw new Error('The clip is too short to find its beat: use at least 4 seconds.');
  const a = 1 - Math.exp(-2 * Math.PI * 150 / rate);
  const lowE = new Float64Array(n), allE = new Float64Array(n);
  let l1 = 0, l2 = 0, total = 0;
  for (let f = 0; f < n; f++) {
    let sl = 0, sa = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) { const x = audio[i]; l1 += (x - l1) * a; l2 += (l1 - l2) * a; sl += l2 * l2; sa += x * x; }
    lowE[f] = sl; allE[f] = sa; total += sa;
  }
  const floor = 1e-4 * total / n + 1e-12;
  const onsets = (E) => {
    const o = new Float64Array(n);
    let m = 0;
    for (let f = 1; f < n; f++) { o[f] = Math.max(0, Math.log(E[f] + floor) - Math.log(E[f - 1] + floor)); m += o[f]; }
    m = m / n || 1;
    for (let f = 0; f < n; f++) o[f] /= m;
    return o;
  };
  const low = onsets(lowE), all = onsets(allE), raw = new Float64Array(n), env = new Float64Array(n);
  for (let f = 0; f < n; f++) raw[f] = low[f] + all[f];
  for (let f = 0; f < n; f++) {        // smoothed a little, so the grid can sit between frames
    let s = 0;
    for (let d = -3; d <= 3; d++) if (f + d >= 0 && f + d < n) s += raw[f + d] * [0.05, 0.12, 0.2, 0.26, 0.2, 0.12, 0.05][d + 3];
    env[f] = s;
  }
  const at = (x, f) => { const i = Math.floor(f), k = f - i; return i + 1 < n ? x[i] * (1 - k) + x[i + 1] * k : 0; };

  // tempo: the beat, 2, 3 and 4 beats apart all line up (autocorrelation)
  const maxLag = Math.ceil(4 * 6000 / minBpm) + 2, ac = new Float64Array(maxLag + 1);
  for (let L = 1; L <= maxLag; L++) { let s = 0; for (let f = 0; f + L < n; f++) s += env[f] * env[f + L]; ac[L] = s / (n - L); }
  const comb = (bpm) => { const P = 6000 / bpm; let s = 0; for (let k = 1; k <= 4; k++) s += at(ac, k * P); return s; };
  let best = minBpm;
  for (let b = minBpm; b < maxBpm; b += 0.1) if (comb(b) > comb(best)) best = b;
  // fine tempo and where the beats are: the grid that sits on the most onsets over the whole song
  const fit = (bpm) => {
    const P = 6000 / bpm;
    let top = -1, phase = 0;
    for (let ph = 0; ph < P; ph += 0.25) { let s = 0; for (let f = ph; f < n - 1; f += P) s += at(env, f); if (s > top) { top = s; phase = ph; } }
    return { score: top, phase };
  };
  let g = { bpm: best, ...fit(best) };
  for (let b = best - 0.3; b <= best + 0.3; b += 0.01) { const x = fit(b); if (x.score > g.score) g = { bpm: b, ...x }; }
  // bar 1: the beat of the four with the most kick (drum & bass: the kick is on 1, never on 3)
  const P = 6000 / g.bpm, kick = [0, 0, 0, 0];
  for (let k = 0, f = g.phase; f < n - 1; k++, f += P) kick[k % 4] += at(low, f);
  const down = kick.indexOf(Math.max(...kick));
  const beat = 60 / g.bpm, firstBar = ((g.phase + down * P) * hop / rate + 0.005) % (4 * beat);
  return { bpm: Math.round(g.bpm * 100) / 100, firstBar: Math.round(firstBar * 1000) / 1000 };
}

// Moving around the grid. Beat k is at firstBar + k beats (k can be negative, before bar 1).
export const beatSec = (g) => 60 / g.bpm;
export const beatOf = (g, t) => (t - g.firstBar) / beatSec(g);
export const beatTime = (g, k) => g.firstBar + k * beatSec(g);
export const snap = (g, t, step = 1) => beatTime(g, Math.round(beatOf(g, t) / step) * step);
export const snapUp = (g, t, step = 1) => beatTime(g, Math.ceil(beatOf(g, t) / step - 1e-6) * step);
export function barBeat(g, t) {           // "bar 33, beat 1" (beat 1 to 4)
  const k = Math.round(beatOf(g, t) * 4) / 4, bar = Math.floor(k / 4) + 1, beat = k - (bar - 1) * 4 + 1;
  return `bar ${bar}, beat ${Number.isInteger(beat) ? beat : beat.toFixed(2)}`;
}

// A first guess at the moment: the first bar where the low end comes back hard after going quiet
// (a drop). Returns its downbeat (s), or null for a clip with no clear one.
export function findDrop(audio, rate, g) {
  const bar = 4 * beatSec(g), a = 1 - Math.exp(-2 * Math.PI * 150 / rate);
  const nBars = Math.floor((audio.length / rate - g.firstBar) / bar), E = new Float64Array(Math.max(0, nBars));
  let l1 = 0, l2 = 0, i = 0;
  for (let k = 0; k < nBars; k++) {
    const end = Math.floor((g.firstBar + (k + 1) * bar) * rate);
    let s = 0;
    for (; i < end; i++) { l1 += (audio[i] - l1) * a; l2 += (l1 - l2) * a; s += l2 * l2; }
    E[k] = s;
  }
  const ratio = (k) => E[k] / ((E[k - 2] + E[k - 1]) / 2 + 1e-9 * E[k]);
  let top = 2;   // at least twice as much bass in the bar as in the 2 before it
  for (let k = 4; k < nBars; k++) top = Math.max(top, ratio(k));
  let best = null;   // the first one nearly as big as the biggest: a song's drops often come back
  for (let k = 4; k < nBars && best === null; k++) if (ratio(k) >= Math.max(2, 0.8 * top)) best = k;
  return best === null ? null : beatTime(g, best * 4);
}

/* ---------- where the marks may go ---------- */
// The lengths Listen for can be, in bars (the drive remembers 9.4 s at most).
export function listenChoices(g) {
  const most = MAX_FRAMES * FRAME_SEC / (4 * beatSec(g));
  const out = [];
  for (let b = LISTEN_BARS.min; b <= LISTEN_BARS.max; b++) if (b <= most + 1e-9) out.push(b);
  return out.length ? out : [Math.max(1, Math.floor(most))];
}

// The earliest Play at: the first beat after the drive has recognised the moment.
export const earliestPlay = (g, recognisedAt) => snapUp(g, recognisedAt + MARGIN);

// Listening placed for a Play at: `bars` long, ending half a beat before it.
export function listenFor(g, playAt, bars) {
  const to = playAt - BEFORE_PLAY * beatSec(g);
  return { from: to - bars * 4 * beatSec(g), to };
}

// Marks that fit together: listening inside the clip (with 1 s before it for the training's lead-in
// to start on), Play at on a beat at or after the earliest. Returns { from, to, playAt }.
export function fitMarks(g, duration, { from, to, playAt }, recognisedAt = to) {
  const len = to - from;
  if (from < 1) { from = 1; to = from + len; }
  if (to > duration - 0.5) { to = duration - 0.5; from = to - len; }
  const first = earliestPlay(g, Math.max(recognisedAt, to - MARGIN));
  playAt = Math.max(snap(g, playAt), first);
  if (playAt > duration) playAt = first;
  return { from, to, playAt };
}

/* ---------- learning and checking (slow: ~1-3 s, the screen runs it in js/moments-worker.js) ---------- */
// Learns what to listen for and checks it the way the drive would hear it: in every HEARINGS room
// around the moment (where it's recognised), and in a club over the whole clip (where else it fires).
// Returns { ok, problem, warning, print (hex), bytes, kept, heard, hearings, recognisedAt, alsoHeardAt }.
export function learnMoment(audio, rate, { from, to }) {
  const pr = trainPrint(audio, rate, to, to - from);
  const print = toHex(packPrint(pr));
  const out = { ok: false, problem: null, warning: null, print, bytes: print.length / 2, kept: pr.kept, heard: 0, hearings: HEARINGS.length, recognisedAt: null, alsoHeardAt: [] };
  if (pr.kept < MIN_KEPT) {
    out.problem = `Too little to learn here: only ${pr.kept} of the drive's sound changes came out the same every time (it needs ${MIN_KEPT}). Pick a busier part of the song, or listen for longer.`;
    return out;
  }
  const near = Math.max(0, from - 12), part = audio.subarray(Math.floor(near * rate), Math.floor(Math.min(audio.length / rate, to + 3) * rate));
  const heard = [];
  for (const h of HEARINGS) {
    const own = hearClip([pr], part, rate, h.room, h.seed, h.pre).map((f) => f.t + near).filter((t) => Math.abs(t - to) < 0.5);
    if (own.length) heard.push(Math.max(...own));
  }
  out.heard = heard.length;
  if (heard.length) out.recognisedAt = Math.round(Math.max(...heard) * 1000) / 1000;
  const whole = hearClip([pr], audio, rate, 'club', 950).map((f) => f.t);
  out.alsoHeardAt = whole.filter((t) => Math.abs(t - to) >= 0.5).map((t) => Math.round(t * 1000) / 1000);
  const tally = `${heard.length} of ${HEARINGS.length} simulated rooms`;
  if (heard.length < MUST_HEAR) out.problem = `The drive recognised it in only ${tally}. Listen for longer, or move listening onto a part with more going on (drums, a vocal, a riff).`;
  else {
    out.ok = true;
    if (heard.length < HEARINGS.length) out.warning = `It was missed once: recognised in ${tally}. Listening for longer may make it surer.`;
  }
  return out;
}

// Where a drive holding `prints` fires (s from the clip's start), hearing the clip in a room.
export function hearClip(prints, audio, rate, room, seed, pre = 1) {
  return listen(prints, stage1(micVolts(audio, rate, room, pre, seed), rate), pre);
}

/* ---------- the quietest room it still hears (firmware R5c; slow too: a few seconds, in the worker) ---------- */
// The drive as Jonny's bench Pulse (A2) measured on 28 Oct 2026: its mic hears music ~6 dB quieter
// than the datasheet's -38 dBV/Pa and rests at 1.35 V (mic check 2), so the 2.1 demo uses the
// 1.5 V range. With these the model needed what the bench needed (firmware pulsetest/README.md).
export const BENCH_DRIVE = { micDbv: -44, bias: 1.35 };
// Levels tried (dB flat: the loud half of the music, where the drive is), loudest first. A level
// counts when at least half its hearings (4 frame timings x 2 noise seeds) recognise the moment:
// even loud, a learnt moment is missed now and then at some frame timings (the R5 finding), so
// "every time" would say more about luck than about the room.
export const QUIET = { loudest: 100, quietest: 56, step: 2, hearings: 8 };
const QUIET_HEARINGS = [...Array(QUIET.hearings)].map((_, i) => ({ pre: 1 + (i % 4) * FRAME_SEC / 4, seed: 930 + i }));

// The music in `part` heard at `spl` dB through a home stereo (its 50 Hz roll-off) and the bench
// drive: how many of the hearings recognise the moment, within 0.5 s of the end of listening.
function heardAtLevel(pr, part, rate, near, to, spl) {
  let n = 0;
  for (const h of QUIET_HEARINGS) {
    const st = stage1(micVolts(part, rate, 'home', h.pre, h.seed, { ...BENCH_DRIVE, spl }), rate);
    if (listen([pr], st, h.pre).some((f) => Math.abs(f.t + near - to) < 0.5)) n++;
  }
  return n;
}

// Turns the music down 4 dB at a time from QUIET.loudest until two levels in a row miss it, then
// tries the 2 dB between. Returns { db (the quietest level heard at least half the time with every
// louder level tried heard too; null if not even at QUIET.loudest), phoneDb (what a phone's sound
// meter, dB(A), would read for this music at that level), heard (of hearings, at db), hearings, levels: [{ db, heard }] }.
export function quietestRoom(audio, rate, print, { from, to }) {
  const pr = typeof print === 'string' ? unpackPrint(fromHex(print)) : print;
  const near = Math.max(0, from - 12), part = audio.subarray(Math.floor(near * rate), Math.floor(Math.min(audio.length / rate, to + 3) * rate));
  const tried = new Map(), heard = (db) => {
    if (!tried.has(db)) tried.set(db, heardAtLevel(pr, part, rate, near, to, db));
    return 2 * tried.get(db) >= QUIET.hearings;
  };
  let best = null, misses = 0;
  for (let db = QUIET.loudest; db >= QUIET.quietest && misses < 2; db -= 2 * QUIET.step) {
    if (heard(db)) { if (!misses) best = db; else break; }
    else misses++;
  }
  if (best !== null && best - QUIET.step >= QUIET.quietest && heard(best - QUIET.step)) best -= QUIET.step;
  const out = { db: best, phoneDb: null, heard: best === null ? tried.get(QUIET.loudest) : tried.get(best), hearings: QUIET.hearings,
    levels: [...tried].map(([db, n]) => ({ db, heard: n })).sort((a, b) => b.db - a.db) };
  if (best !== null) out.phoneDb = Math.round(best + aWeighting(audio.subarray(Math.floor(from * rate), Math.floor(to * rate)), rate));
  return out;
}

// dB(A) minus dB flat for this music (after the stereo's 50 Hz roll-off): how much lower a phone's
// sound meter reads. Drum & bass, mostly bass, reads a few dB lower; a vocal part about the same.
export function aWeighting(x, rate) {
  let N = 1;
  while (N < rate) N *= 2;
  const ra = (f) => { const f2 = f * f; return 12194 ** 2 * f2 * f2 / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)); };
  const a1k = ra(1000), wins = [];
  for (let i = 0; i + N <= x.length; i += N) {
    const re = Float64Array.from(x.subarray(i, i + N)), im = new Float64Array(N);
    fft(re, im);
    let flat = 0, aw = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = k * rate / N, p = (re[k] * re[k] + im[k] * im[k]) * f ** 4 / (f ** 4 + 50 ** 4), a = ra(f) / a1k;
      flat += p; aw += p * a * a;
    }
    if (flat > 0) wins.push({ flat, aw });
  }
  if (!wins.length) return 0;
  wins.sort((a, b) => a.flat - b.flat);
  const loud = wins.slice(Math.floor(wins.length / 2));   // the loud half, as the rooms' levels are measured
  return 10 * Math.log10(loud.reduce((s, w) => s + w.aw, 0) / loud.reduce((s, w) => s + w.flat, 0));
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len *= 2) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Another clip, the demo track or a crowd: where a moment would fire on it (should be nowhere).
export function checkOther(moment, audio, rate, room = 'club', seed = 960) {
  return hearClip([momentPrint(moment)], audio, rate, room, seed).map((f) => Math.round(f.t * 1000) / 1000);
}

/* ---------- the moment file (library moments/ folder) ---------- */
// { type, name, board, song (its file in songs/), bpm, firstBar, listenFrom, listenTo, playAt,
//   delayMs and delayBeats (Play at after the end of listening: what the drive waits), animation
//   (a name in animations/), repeat ("every" or "first"), print (hex: js/songs.js packPrint), kept,
//   heard (of the 8 simulated rooms), recognisedAt, alsoHeardAt (other places in the song it fires), checkedAgainst,
//   quietDb and quietPhoneDb (quietestRoom: null if not worked out, or not heard even at its loudest) }
const r3 = (x) => Math.round(x * 1000) / 1000;
export function makeMoment(m) {
  const name = String(m.name == null ? '' : m.name).trim();
  if (!name) throw new Error('Give the song moment a name.');
  if (!m.song) throw new Error('Choose a song first.');
  if (!m.animation) throw new Error('Choose an animation to play.');
  if (!m.print) throw new Error('The drive hasn\'t learnt this moment yet. Wait for "Learnt" before saving.');
  const g = { bpm: m.bpm, firstBar: m.firstBar };
  if (m.playAt < m.listenTo) throw new Error('Play at has to be after listening ends.');
  return {
    type: 'song-moment', name, board: 'pulse', song: m.song,
    bpm: m.bpm, firstBar: r3(m.firstBar),
    listenFrom: r3(m.listenFrom), listenTo: r3(m.listenTo), playAt: r3(m.playAt),
    delayMs: Math.round((m.playAt - m.listenTo) * 1000),
    delayBeats: Math.round((m.playAt - m.listenTo) / beatSec(g) * 16) / 16,
    animation: m.animation, repeat: m.repeat === 'first' ? 'first' : 'every',
    print: m.print, kept: m.kept, heard: m.heard ?? null, recognisedAt: m.recognisedAt == null ? null : r3(m.recognisedAt),
    alsoHeardAt: (m.alsoHeardAt || []).map(r3), checkedAgainst: m.checkedAgainst || [],
    quietDb: Number.isFinite(m.quietDb) ? m.quietDb : null, quietPhoneDb: Number.isFinite(m.quietPhoneDb) ? m.quietPhoneDb : null,
  };
}
export const isMoment = (x) => !!x && x.type === 'song-moment' && typeof x.name === 'string' && typeof x.print === 'string' && Number.isFinite(x.delayMs);
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export function momentFileName(m) {
  const s = slug(m.name);
  if (!s) throw new Error('Give the song moment a name.');
  return `pulse-${s}.json`;
}
export const momentPrint = (m) => unpackPrint(fromHex(m.print));

export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));

/* ---------- what the drive does ---------- */
// The drive holding `moments` hears a recording (a stage1 run, music from `pre` s): every
// time it recognises one, it waits delayMs and plays. "first" moments play once per plug-in.
// Returns [{ moment (index), heardAt, playAt }] in s from the music's start.
export function drivePlays(moments, st, pre = 0) {
  const played = new Set(), out = [];
  for (const f of listen(moments.map(momentPrint), st, pre)) {
    const m = moments[f.print];
    if (m.repeat === 'first' && played.has(f.print)) continue;
    played.add(f.print);
    out.push({ moment: f.print, heardAt: f.t, playAt: f.t + m.delayMs / 1000 });
  }
  return out;
}

export const fmtTime = (s) => `${s < 0 ? '−' : ''}${Math.floor(Math.abs(s) / 60)}:${(Math.abs(s) % 60).toFixed(1).padStart(4, '0')}`;
