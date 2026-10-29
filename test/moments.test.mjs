// Song moments (roadmap R4), with synthetic tracks only: real clips stay out of the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/preview-pulse.js';
import { crowd, withCrowd } from '../js/songs.js';
import { Library, MemoryStore } from '../js/library.js';
import {
  beatGrid, beatSec, snap, earliestPlay, listenChoices, listenFor, fitMarks, barBeat, learnMoment, makeMoment,
  isMoment, momentFileName, drivePlays, checkOther, findDrop, MARGIN, MUST_HEAR, quietestRoom, aWeighting, QUIET, BENCH_DRIVE,
} from '../js/moments.js';

const RATE = 8000;
const hear = (audio, room, seed, pre = 1) => ({ st: P.stage1(P.micVolts(audio, RATE, room, pre, seed), RATE), pre });

// A song with a breakdown and a build-up (noise swelling), the drop, and (for the second test)
// the same again later, as Poison has its drop at 1:28 and again at 3:29.
function makeSong({ bars, drops }) {
  const s = P.synthDnb(RATE, { bars, breakFrom: 99 });
  const bar = (b) => s.start + b * 8 * s.eighth;
  const clean = P.synthDnb(RATE, { bars, breakFrom: drops[0] - 4, breakTo: drops[0] });
  for (const d of drops) {             // copy the first breakdown and drop over the plain track
    const from = Math.floor(bar(d - 4) * RATE), to = Math.floor(bar(d + 2) * RATE), off = Math.floor((bar(drops[0]) - bar(d)) * RATE);
    for (let i = from; i < to; i++) s.audio[i] = clean.audio[i + off];
    let seed = 77;
    for (let i = from; i < Math.floor(bar(d) * RATE); i++) {
      const u = (i - from) / (bar(d) * RATE - from);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      s.audio[i] += 0.5 * u * u * (seed / 2 ** 31 - 1);
    }
  }
  return { audio: s.audio, bar };
}

test('the beat grid finds the tempo and bar 1', () => {
  for (const bpm of [174, 140]) {
    const s = P.synthDnb(RATE, { bpm, bars: 30 });
    const g = beatGrid(s.audio, RATE);
    assert.ok(Math.abs(g.bpm - bpm) < 0.05, `${bpm}: found ${g.bpm}`);
    const barLen = 8 * s.eighth, off = ((g.firstBar - s.start) / barLen) % 1;
    assert.ok(Math.min(Math.abs(off), Math.abs(1 - off)) * barLen < 0.015, `${bpm}: bar 1 ${g.firstBar} s, the track's bars start at ${s.start} s`);
  }
  assert.throws(() => beatGrid(new Float32Array(RATE), RATE), /too short/);
});

test('Play at snaps to beats and never goes before the drive has recognised the moment', () => {
  const g = { bpm: 174, firstBar: 0.3 }, b = beatSec(g);
  assert.deepEqual(listenChoices(g), [3, 4, 5, 6]);
  assert.deepEqual(listenChoices({ bpm: 100, firstBar: 0 }), [3], 'the drive remembers 9.4 s: 4 bars at 100 BPM is 9.6 s');
  assert.ok(Math.abs(snap(g, 0.3 + 10.4 * b) - (0.3 + 10 * b)) < 1e-9);
  const L = listenFor(g, 0.3 + 64 * b, 4);
  assert.ok(Math.abs(L.to - L.from - 16 * b) < 1e-9 && Math.abs(0.3 + 64 * b - L.to - b / 2) < 1e-9, '4 bars, ending half a beat before');
  // recognised just after a beat: the earliest Play at is the next beat
  assert.ok(Math.abs(earliestPlay(g, 0.3 + 64 * b - MARGIN + 0.001) - (0.3 + 65 * b)) < 1e-9);
  const m = fitMarks(g, 200, { from: L.from, to: L.to, playAt: 0.3 + 60 * b }, L.to);
  assert.ok(Math.abs(m.playAt - (0.3 + 64 * b)) < 1e-9, 'dragged too early, Play at stops at the first beat after listening');
  assert.equal(barBeat(g, 0.3 + 64 * b), 'bar 17, beat 1');
});

test('a saved moment, heard through the simulated mic, plays at Play at ±1 beat with its song and never with other clips', async () => {
  const song = makeSong({ bars: 26, drops: [16] }), g = beatGrid(song.audio, RATE), beat = beatSec(g);
  const playAt = snap(g, song.bar(18));
  const L = listenFor(g, playAt, 4);
  const learnt = learnMoment(song.audio, RATE, L);
  assert.ok(learnt.ok, learnt.problem);
  assert.ok(learnt.heard >= MUST_HEAR, `recognised in ${learnt.heard} of ${learnt.hearings} simulated rooms`);
  assert.ok(Math.abs(learnt.recognisedAt - L.to) < 0.1, `recognised at ${learnt.recognisedAt}, listening ends ${L.to.toFixed(3)}`);
  assert.deepEqual(learnt.alsoHeardAt, [], 'nowhere else in the song');
  const marks = fitMarks(g, song.audio.length / RATE, { ...L, playAt }, learnt.recognisedAt);
  assert.ok(Math.abs(marks.playAt - playAt) < 1e-9, 'Play at can stay on the drop');

  // save it in a library (the clip goes in songs/, the moment in moments/) and read it back
  const lib = new Library(new MemoryStore());
  await lib.addSong('Synthetic drop.wav', new Uint8Array([1, 2, 3]));
  assert.deepEqual(await lib.songs(), ['Synthetic drop.wav']);
  assert.deepEqual([...new Uint8Array(await lib.readSong('Synthetic drop.wav'))], [1, 2, 3]);
  const { moment, file } = await lib.saveMoment(makeMoment({
    name: 'The drop', song: 'Synthetic drop.wav', ...g, listenFrom: marks.from, listenTo: marks.to, playAt: marks.playAt,
    animation: 'Drop (example)', print: learnt.print, kept: learnt.kept, recognisedAt: learnt.recognisedAt,
  }));
  assert.equal(file, 'pulse-the-drop.json');
  assert.equal(momentFileName(moment), file);
  const [saved] = await lib.moments();
  assert.ok(isMoment(saved));
  assert.equal(saved.delayBeats, 0.5);
  assert.equal(saved.delayMs, Math.round(beat / 2 * 1000));

  // its song, in rooms and with noise the training never used: plays once, on the beat
  for (const [audio, room, seed] of [[song.audio, 'rig', 3], [song.audio, 'bar', 4], [withCrowd(song.audio, RATE, 0.2, 4242), 'club', 5]]) {
    const { st, pre } = hear(audio, room, seed);
    const plays = drivePlays([saved], st, pre);
    assert.equal(plays.length, 1, `${room}: ${plays.map((p) => p.playAt.toFixed(2))}`);
    assert.ok(Math.abs(plays[0].playAt - saved.playAt) <= beat, `${room}: played at ${plays[0].playAt.toFixed(3)}, Play at ${saved.playAt}`);
  }
  // other clips: a house track at the same tempo, drum & bass in another key and groove, a crowd, a quiet room
  const others = [
    [P.synthDnb(RATE, { bars: 26, breakFrom: 99, house: true, seed: 5 }).audio, 'club'],
    [P.synthDnb(RATE, { bars: 26, breakFrom: 6, breakTo: 8, seed: 9 }).audio, 'rig'],
    [crowd(RATE * 30, RATE, 9), 'bar'],
    [new Float32Array(RATE * 20), 'silence'],
  ];
  for (const [audio, room] of others) {
    const { st, pre } = hear(audio, room, 6);
    assert.deepEqual(drivePlays([saved], st, pre), [], room);
  }
  assert.deepEqual(checkOther(saved, others[0][0], RATE), [], 'the screen\'s "check other songs" says the same');
});

test('the quietest room it still hears: the bench Pulse needs ~74 dB of drum & bass, as the firmware\'s sweep says', () => {
  const song = makeSong({ bars: 26, drops: [16] }), g = beatGrid(song.audio, RATE);
  const L = listenFor(g, snap(g, song.bar(18)), 4), learnt = learnMoment(song.audio, RATE, L);
  const q = quietestRoom(song.audio, RATE, learnt.print, L);
  // firmware pulsetest/tests/quiet_sweep.mjs mic=-44 bias=1.35 (the bench drive): half the time from 71, every time from 74
  assert.ok(q.db >= 70 && q.db <= 80, `quietest ${q.db} dB: ${JSON.stringify(q.levels)}`);
  assert.ok(2 * q.heard >= q.hearings);
  for (const l of q.levels) if (l.db >= q.db) assert.ok(2 * l.heard >= QUIET.hearings, `${l.db} dB louder than ${q.db}, heard ${l.heard}`);
  assert.ok(q.levels.some((l) => l.db < q.db && 2 * l.heard < QUIET.hearings), 'a quieter level was tried and mostly missed');
  assert.ok(q.phoneDb < q.db && q.phoneDb > q.db - 15, `a phone reads drum & bass lower: ${q.phoneDb} dB(A) at ${q.db} dB`);
  // the screen sends only the music around the moment: same answer
  const near = L.from - 12, part = song.audio.slice(Math.floor(near * RATE), Math.floor((L.to + 3) * RATE));
  assert.deepEqual(quietestRoom(part, RATE, learnt.print, { from: L.from - near, to: L.to - near }), q);
  // the default mic (the datasheet's, resting 0.9 V) is untouched by the bench drive's options
  const v1 = P.micVolts(part, RATE, 'home', 1, 3), v2 = P.micVolts(part, RATE, 'home', 1, 3, { spl: P.ROOMS.home.spl, micDbv: -38, bias: 0.9 });
  assert.deepEqual(v1, v2);
  const quiet = P.micVolts(part, RATE, 'home', 1, 3, { ...BENCH_DRIVE, spl: 60 });
  assert.ok(Math.abs(quiet[0] - BENCH_DRIVE.bias) < 0.01, 'rests at the bench drive\'s 1.35 V');
  // and the moment file keeps it
  const m = makeMoment({ name: 'Quiet', song: 's.wav', ...g, listenFrom: L.from, listenTo: L.to, playAt: L.to + 0.1, animation: 'Drop (example)', print: learnt.print, kept: learnt.kept, quietDb: q.db, quietPhoneDb: q.phoneDb });
  assert.equal(m.quietDb, q.db);
  assert.equal(makeMoment({ ...m, quietDb: undefined }).quietDb, null);
});

test('a phone\'s dB(A): 1 kHz reads the same, bass much lower', () => {
  const r = 16000, tone = (f) => Float32Array.from({ length: r * 4 }, (_, i) => Math.sin(2 * Math.PI * f * i / r));
  assert.ok(Math.abs(aWeighting(tone(1000), r)) < 0.1);
  assert.ok(Math.abs(aWeighting(tone(100), r) + 19.1) < 0.6, `100 Hz: ${aWeighting(tone(100), r)}`);
});

test('a moment the song repeats: found again, and "first time only" plays it once', () => {
  const song = makeSong({ bars: 46, drops: [16, 36] }), g = beatGrid(song.audio, RATE);
  const playAt = snap(g, song.bar(18)), L = listenFor(g, playAt, 4);
  const learnt = learnMoment(song.audio, RATE, L);
  assert.ok(learnt.ok, learnt.problem);
  assert.equal(learnt.alsoHeardAt.length, 1);
  assert.ok(Math.abs(learnt.alsoHeardAt[0] - (L.to + song.bar(36) - song.bar(16))) < 0.1, `also at ${learnt.alsoHeardAt}`);
  const base = { name: 'Twice', song: 'twice.wav', ...g, listenFrom: L.from, listenTo: L.to, playAt, animation: 'Drop (example)', print: learnt.print, kept: learnt.kept };
  const { st, pre } = hear(song.audio, 'club', 11);
  assert.equal(drivePlays([makeMoment(base)], st, pre).length, 2);
  assert.equal(drivePlays([makeMoment({ ...base, repeat: 'first' })], st, pre).length, 1);
});

test('too little to learn, or a moment that isn\'t finished, gets a plain message', () => {
  const song = makeSong({ bars: 26, drops: [16] });
  const r = learnMoment(song.audio, RATE, { from: song.bar(18) - 0.7, to: song.bar(18) });   // half a bar
  assert.equal(r.ok, false);
  assert.match(r.problem, /Too little to learn here/);
  assert.throws(() => makeMoment({ name: '', song: 'a.wav' }), /Give the song moment a name/);
  assert.throws(() => makeMoment({ name: 'x', song: 'a.wav', animation: 'Drop' }), /hasn't learnt/);
});

test('the first guess at the moment is the drop', () => {
  const song = makeSong({ bars: 26, drops: [16] }), g = beatGrid(song.audio, RATE);
  assert.ok(Math.abs(findDrop(song.audio, RATE, g) - song.bar(16)) < 0.02);
  assert.equal(findDrop(P.synthDnb(RATE, { bars: 20, breakFrom: 99 }).audio.subarray(RATE * 3), RATE, g), null, 'no breakdown, no drop');
});
