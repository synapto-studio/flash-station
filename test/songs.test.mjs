// Song moments (roadmap R1), with synthetic tracks only: real clips stay out of the repo
// (test/song_experiment.mjs runs them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/preview-pulse.js';
import {
  log2x16, FrameMaker, Matcher, frameCodes, compare, listen, trainPrint, packPrint, unpackPrint, printBytes, withLimits,
  withCrowd, crowd, FRAME_SEC, FRAME_BLOCKS, RING, MAX_FRAMES, MIN_KEPT, STRETCH,
} from '../js/songs.js';

const RATE = 8000, BAR = 240 / 174;
const hear = (audio, room, seed, pre = 1) => ({ st: P.stage1(P.micVolts(audio, RATE, room, pre, seed), RATE), pre });
function speed(x, f) {
  const n = Math.floor((x.length - 1) / f), y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * f, j = Math.floor(p), a = p - j; y[i] = x[j] * (1 - a) + x[j + 1] * a; }
  return y;
}

test('log2 x16 is the firmware\'s: within 2/16 of the true value, never going down', () => {
  let last = 0;
  for (let v = 2; v < 2 ** 31; v = Math.ceil(v * 1.013) + 1) {
    const l = log2x16(v);
    assert.ok(Math.abs(l - 16 * Math.log2(v)) <= 2, `v=${v}`);
    assert.ok(l >= last, `v=${v}`);
    last = l;
  }
  assert.equal(log2x16(0), 0);
  assert.equal(log2x16(1024), 160);
});

test('a frame is 6 blocks; its 5 bits say what got louder; blocks marked not ok repeat the last good one', () => {
  const fm = new FrameMaker(), codes = [];
  const feed = (k, s, a, ok = 1) => { for (let i = 0; i < FRAME_BLOCKS; i++) { const c = fm.push(k, s, a, ok); if (c >= 0) codes.push(c); } };
  feed(1000, 1000, 1000);
  feed(4000, 1000, 2000);    // kick up, whole up, balance to the kick, whole up on 2 frames ago
  feed(4000, 3000, 2000);    // the snare up
  feed(1, 1, 1, 0);          // not ok: same as the frame before, so nothing is louder
  assert.equal(codes.length, 4);
  assert.equal(codes[1], 0b11101);
  assert.equal(codes[2], 0b10010);    // the whole signal is still louder than 2 frames ago
  assert.equal(codes[3], 0b00000);
});

test('a print packs into 7 bytes + 10 bits a frame and unpacks the same', () => {
  const W = 71, value = new Uint8Array(W), mask = new Uint8Array(W);
  for (let i = 0; i < W; i++) { value[i] = (i * 7) & 31; mask[i] = (i * 13 + 5) & 31; }
  const pr = withLimits({ frames: W, value, mask });
  assert.equal(pr.parts.reduce((a, b) => a + b), pr.kept);
  assert.equal(pr.maxErr, Math.floor(41 * pr.kept / 256));
  const b = packPrint(pr);
  assert.equal(b.length, printBytes(W));
  assert.equal(printBytes(W), 96, '4 bars at 174 BPM');
  const u = unpackPrint(b);
  assert.deepEqual([u.frames, u.maxErr, u.kept], [W, pr.maxErr, pr.kept]);
  assert.deepEqual(u.partMax, pr.partMax);
  assert.deepEqual(u.value, value);
  assert.deepEqual(u.mask, mask);
  assert.ok(((MAX_FRAMES - 1) * Math.max(...STRETCH) + 128 >> 8) + 2 <= RING, 'the longest print, slowed 2 %, fits the drive\'s memory');
});

// A demo-style track with a breakdown (bars 12-15) and the drop at bar 16. The demo loops the same
// bars over and over, so it gets what real tracks have and loops don't: a one-off build-up (noise
// swelling through the breakdown). The moment is 2 bars after the drop, so the 4 bars it
// listens to hold the change, as Jonny's real moments do.
const song = P.synthDnb(RATE, { bars: 26, breakFrom: 12, breakTo: 16 });
const at = (bar) => song.start + bar * 8 * song.eighth;
(function riser(x, from, to) {
  let seed = 77;
  for (let i = Math.floor(from * RATE); i < to * RATE; i++) {
    const u = (i / RATE - from) / (to - from);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    x[i] += 0.5 * u * u * (seed / 2 ** 31 - 1);
  }
})(song.audio, at(12), at(16));
const moment = at(18);
const print = trainPrint(song.audio, RATE, moment, 4 * BAR);

test('training keeps the bits the drive will hear the same way, and enough of them', () => {
  assert.equal(print.frames, Math.round(4 * BAR / FRAME_SEC));
  assert.ok(print.kept >= MIN_KEPT, `kept ${print.kept}`);
  assert.ok(print.kept < print.frames * 5, 'some bits are "don\'t care"');
  assert.ok(print.parts.every((n) => n > 0), 'every quarter keeps some bits');
});

test('the drive finds the moment, and only there, in another room, with a crowd, and with the DJ 1 % fast', () => {
  const beat = 60 / 174;
  for (const [audio, room, f] of [[song.audio, 'rig', 1], [withCrowd(song.audio, RATE, 0.2, 4242), 'bar', 1], [speed(song.audio, 1.01), 'club', 1.01]]) {
    const { st, pre } = hear(audio, room, 3);
    const fires = listen([print], st, pre);
    assert.equal(fires.length, 1, `${room} x${f}: ${fires.map((x) => x.t.toFixed(2))}`);
    assert.ok(Math.abs(fires[0].t - moment / f) <= beat, `${room} x${f}: ${fires[0].t.toFixed(2)}`);
  }
});

test('it never fires on another track at the same tempo, on a crowd, or in a quiet room', () => {
  const other = P.synthDnb(RATE, { bars: 26, breakFrom: 99, house: true, seed: 5 }).audio;
  for (const [audio, room] of [[other, 'club'], [crowd(RATE * 30, RATE, 9), 'bar'], [new Float32Array(RATE * 20), 'silence']]) {
    const { st, pre } = hear(audio, room, 5);
    assert.deepEqual(listen([print], st, pre), [], room);
  }
});

test('the drive\'s Matcher fires exactly where the app\'s compare says it should', () => {
  const { st, pre } = hear(song.audio, 'home', 8);
  const { codes } = frameCodes(st, pre);
  const m = new Matcher([print]);
  let lock = 0;
  for (let j = 0; j < codes.length; j++) {
    const fired = m.pushFrame(codes[j]).length > 0;
    const history = j + 1 > ((print.frames - 1) * 261 + 128 >> 8) + 1;
    const should = !lock && history && compare(codes, j, print).match;
    assert.equal(fired, should, `frame ${j}`);
    if (lock) lock--; else if (fired) lock = print.frames;
  }
});
