// Light cues (R8): key presses become a beat-timed one-shot recipe a Pulse can play as a song
// moment's animation. The screen (js/cues-tab.js) is checked in headless Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/cues.js';
import * as P from '../js/player.js';
import * as L from '../js/lab.js';
import { defaultProfile } from '../js/profiles.js';
import { demoMissing } from '../js/show.js';

const drive = P.makeDrive(defaultProfile('pulse'));
const BPM = 174, BEAT_MS = 60000 / BPM;
const WHITE = [255, 255, 255], GREEN = [159, 255, 82], ORANGE = [255, 80, 0];
const cue = (kind, at, len, more = {}) => ({ kind, at, for: len, zone: 'all', colour: C.KINDS[kind].white ? WHITE : GREEN, level: 100, ...more });
function play(cues, under) {
  const b = C.build({ cues, under, drive });
  const show = new P.Show({ sections: [b.anim], drive, colours: {}, brightness: 255, bpm: BPM });
  return { ...b, at: (beats) => show.frame(Math.round(beats * BEAT_MS)) };
}
const sum = (px) => px.reduce((s, c) => s + c[0] + c[1] + c[2], 0);
const dark = (px) => px.every((c) => c.every((v) => v === 0));

test('top, middle and bottom come from the drive profile (front and back LEDs together)', () => {
  assert.deepEqual(C.zones(drive), { all: [1, 2, 3, 4, 5, 6, 7, 8], top: [5, 6], middle: [3, 4], bottom: [1, 2, 7, 8] });
  const many = { count: 4, heights: [0, 4000, 6000, 10000] };
  assert.deepEqual(C.zones(many), { all: [1, 2, 3, 4], top: [4], middle: [2, 3], bottom: [1] });
});

test('each kind of cue looks the way it says', () => {
  const under = { colour: ORANGE, level: 30 };
  const p = play([
    cue('white', 0, 1), cue('bright', 2, 1), cue('shimmer', 4, 1, { zone: 'middle' }), cue('stutter', 6, 1, { zone: 'bottom' }),
    cue('cut', 8, 1), cue('fadeUp', 10, 1, { zone: 'top' }), cue('fadeDown', 12, 1, { zone: 'middle' }),
  ], under);
  const base = p.at(1.5); // between cues: only what's under
  // white pulse: bright white at once, back to what's under by its end
  assert.ok(sum(p.at(0.02)) > 5000);
  assert.ok(p.at(0.02)[0][2] > 200, 'it is white');
  assert.ok(sum(p.at(0.98)) < sum(base) * 1.3);
  // brightness pulse: what's under, lifted (keeps its colour: no blue)
  assert.ok(sum(p.at(2.05)) > sum(base) * 3);
  assert.equal(p.at(2.05)[0][2], 0);
  // shimmer on the middle LEDs only, flickering
  const mid = [4.1, 4.15, 4.2, 4.25, 4.3].map((b) => p.at(b)[2][0]);
  assert.ok(Math.max(...mid) - Math.min(...mid) > 50, `shimmer flickers: ${mid}`);
  assert.deepEqual(p.at(4.1)[4], base[4], 'top LEDs untouched');
  // stutter: on, then dark, on every 16th note
  assert.ok(p.at(6.02)[0][1] > 100 && dark([p.at(6.2)[0]]) && p.at(6.27)[0][1] > 100);
  // cut out: everything dark, then back
  assert.ok(dark(p.at(8.5)));
  assert.deepEqual(p.at(9.2), base);
  // fades: halfway between what's under and the colour
  assert.ok(p.at(10.5)[4][1] > base[4][1] && p.at(10.5)[4][1] < p.at(10.98)[4][1]);
  assert.ok(p.at(12.02)[2][1] > p.at(12.5)[2][1]);
  // after the last cue: dark (the moment ends, the drive goes back to its own look)
  assert.ok(dark(p.at(14.1)));
});

test('a cut goes dark over cues that started at the same time', () => {
  const p = play([cue('cut', 0, 1), cue('shimmer', 0, 2), cue('white', 0.5, 1)]);
  for (const b of [0.1, 0.3, 0.6, 0.9]) assert.ok(dark(p.at(b)), `dark at ${b}`);
  assert.ok(sum(p.at(1.6)) > 0, 'the shimmer carries on after the cut and the white pulse');
});

test('the recipe is a beat-timed one-shot for a Pulse, using only what the 2.1 demo plays', () => {
  const p = play([cue('white', 0, 0.5), cue('stutter', 1, 2), cue('fadeDown', 3, 1)], { colour: ORANGE, level: 20 });
  assert.equal(p.recipe.board, 'pulse');
  assert.equal(p.recipe.timing, 'beats');
  assert.equal(p.recipe.once, true);
  assert.deepEqual(demoMissing(p.anim), []);   // moves, curves and blends the demo has (firmware tools/demo_moves.mjs)
  assert.equal(P.length(p.anim), 4, '4 beats long');
  // the lab reads it back the same, and its bytes unpack to it
  const back = L.readRecipe(L.recipeText(p.recipe));
  assert.equal(back.bytes, p.bytes);
  assert.deepEqual(P.pack(P.unpack(P.pack(p.recipe), { name: p.recipe.name, board: 'pulse' })), P.pack(p.recipe));
});

test('colours: the same one is kept once, at most 10, black is off', () => {
  const p = play([cue('white', 0, 1), cue('shimmer', 1, 1), cue('stutter', 2, 1, { colour: [0, 0, 0] })], { colour: WHITE, level: 50 });
  assert.deepEqual(p.recipe.custom, [WHITE]);
  const eleven = Array.from({ length: 11 }, (_, i) => cue('stutter', i, 1, { colour: [i * 20, 0, 0 + 1] }));
  assert.throws(() => C.build({ cues: eleven, drive }), /more than 10 different colours/);
});

test('at most 14 cues (a recipe has 15 layers); each cue is about 7 to 13 bytes', () => {
  const many = Array.from({ length: 15 }, (_, i) => cue('white', i, 0.5));
  assert.throws(() => C.build({ cues: many, drive }), /one animation can have 14/);
  const b = C.build({ cues: many.slice(0, 14), drive });
  assert.equal(b.anim.layers.length, 15);
  const one = C.build({ cues: [cue('white', 0, 0.5)], drive }).bytes;
  const two = C.build({ cues: [cue('white', 0, 0.5), cue('cut', 1, 0.5)], drive }).bytes;
  assert.ok(two - one >= 4 && two - one <= 13, `a cut costs ${two - one} bytes`);
  // a typical burst of 8 cues fits on the 2.1 demo, 3 like it next to Poison's moment
  const burst = C.build({ cues: ['white', 'cut', 'shimmer', 'stutter', 'white', 'fadeUp', 'fadeDown', 'bright'].map((k, i) => cue(k, i, 1)), drive });
  assert.ok(burst.bytes <= C.DEMO_ROOM, `${burst.bytes} bytes`);
});

test('times snap to the recipe\'s 1/16 beat, and the length is whole beats', () => {
  assert.equal(C.snapTo(1.13, 0.25), 1.25);
  assert.equal(C.cuesLength([cue('white', 2.3, 0.4)]), 3);
  const p = C.build({ cues: [cue('white', 0.05, 0.4)], drive });
  assert.equal(p.recipe.layers[1].at, 0.0625);
  assert.equal(p.recipe.layers[1].for, 0.375);
  assert.equal(C.whereText(0), 'bar 1, beat 1');
  assert.equal(C.whereText(5.5), 'bar 2, beat 2½');
});

test('cues kept in the browser are checked before they are used', () => {
  const good = cue('white', 1, 1);
  assert.deepEqual(C.cleanCues([good, { kind: 'laser', at: 1, for: 1 }, null, { ...good, at: -1 }, { ...good, zone: 'left' }]), [good]);
  assert.deepEqual(C.cleanCues('nonsense'), []);
});
