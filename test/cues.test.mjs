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

test('at most 15 cues (a recipe has 15 layers), 14 over a colour; each cue is about 7 to 13 bytes', () => {
  const many = Array.from({ length: 16 }, (_, i) => cue('white', i, 0.5));
  assert.throws(() => C.build({ cues: many, drive }), /one animation can have 15/);
  assert.equal(C.build({ cues: many.slice(0, 15), drive }).anim.layers.length, 15, 'over the normal look: no layer for what\'s under');
  assert.equal(C.build({ cues: many.slice(0, 15), drive, under: { mode: 'dark' } }).anim.layers.length, 15);
  assert.throws(() => C.build({ cues: many.slice(0, 15), drive, under: { mode: 'colour', colour: ORANGE, level: 20 } }), /one animation can have 14 over a colour/);
  const b = C.build({ cues: many.slice(0, 14), drive, under: { colour: ORANGE, level: 20 } });
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
  assert.equal(p.recipe.layers[0].at, 0.0625);
  assert.equal(p.recipe.layers[0].for, 0.375);
  assert.equal(C.whereText(0), 'bar 1, beat 1');
  assert.equal(C.whereText(5.5), 'bar 2, beat 2½');
});

test('cues kept in the browser are checked before they are used', () => {
  const good = cue('white', 1, 1);
  assert.deepEqual(C.cleanCues([good, { kind: 'laser', at: 1, for: 1 }, null, { ...good, at: -1 }, { ...good, zone: 'left' }]), [good]);
  assert.deepEqual(C.cleanCues('nonsense'), []);
});

// ---------------------------------------------------------------- R9: over the normal look, kicks and snares
import * as pulse from '../js/preview-pulse.js';
import * as A from '../js/animations.js';

// The demo track through the simulated mic in a club: the drive's music clock from `fromBar`, and
// the kicks and snares it hears, in beats from there (as the Light cues screen works them out).
function heard(fromBar = 4) {
  const d = pulse.synthDnb(8000, { bars: 14 }), PRE = 1, beatS = 2 * d.eighth, start = d.start + fromBar * 4 * beatS;
  const st = pulse.stage1(pulse.micVolts(d.audio, 8000, 'club', PRE, 7), 8000), run = pulse.stage2(st, pulse.DEFAULTS);
  const base = A.pulseMusic(run, st), shift = (start + PRE) * 1000 - run.startMs;
  const hits = { kick: [], snare: [] };
  for (let i = 0; i < st.n; i++) {
    const b = (st.now[i] / 1000 - PRE - start) / beatS;
    if (b < 0) continue;
    if (run.kOn[i]) hits.kick.push(b);
    if (run.sOn[i]) hits.snare.push(b);
  }
  return { music: (ms) => base(ms + shift), hits, beatS };
}

test('over the normal look: no layer under the cues, a cut goes dark over it, a white pulse fades back into it', () => {
  const ambient = A.pulseAmbient(), colours = { red: [255, 0, 0], orange: [255, 45, 0] };
  const b = C.build({ cues: [cue('white', 0, 1, { zone: 'top' }), cue('cut', 2, 1, { zone: 'bottom' })], drive });
  assert.equal(b.recipe.over, true);
  assert.equal(b.anim.layers.length, 2);
  assert.deepEqual(b.anim.layers.map((l) => [l.move, l.blend]), [['fade', 'flash'], ['glow', undefined]]);
  const show = new P.Show({ sections: [b.anim], under: ambient, drive, colours, bpm: BPM });
  const look = new P.Show({ sections: [ambient], drive, colours, bpm: BPM });
  const at = (sh, beats) => sh.frame(Math.round(beats * BEAT_MS));
  assert.ok(at(show, 0.02)[4].every((v) => v > 230), 'white at the top');
  assert.deepEqual(at(show, 0.02).slice(0, 4), at(look, 0.02).slice(0, 4), 'the rest is the normal look');
  const end = at(show, 0.97)[4], lookEnd = at(look, 0.97)[4];
  assert.ok(end.every((v, j) => Math.abs(v - lookEnd[j]) <= 12), `back into the look by the end: ${end} vs ${lookEnd}`);
  assert.ok(dark([0, 1, 6, 7].map((k) => at(show, 2.5)[k])), 'cut out: the bottom dark');
  assert.deepEqual(at(show, 2.5)[4], at(look, 2.5)[4], 'the top still the normal look');
  assert.deepEqual(demoMissing(b.anim), []);
});

test('the normal look in new colours: recolour turns its red and orange into the colours picked', () => {
  const BLUE = [0, 40, 255], PINK = [255, 0, 140];
  const b = C.build({ cues: [cue('bright', 0, 1)], drive, under: { mode: 'recolour', colours: { 1: BLUE, 2: PINK } } });
  assert.deepEqual(b.recipe.recolour, { 1: 6, 2: 7 });
  assert.deepEqual(b.recipe.custom, [BLUE, PINK]);
  const black = C.build({ cues: [cue('bright', 0, 1)], drive, under: { mode: 'recolour', colours: { 1: [0, 0, 0] } } });
  assert.deepEqual(black.recipe.recolour, { 1: 6 }, 'black is a colour here too (red off)');
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, bpm: BPM });
  const px = show.frame(Math.round(0.5 * BEAT_MS));
  assert.ok(px[2][2] > 30 && px[2][0] === 0, `the middle, red in the look, is blue: ${px[2]}`);
  assert.equal(P.length(b.anim), 1);
  assert.deepEqual(show.frame(Math.round(1.5 * BEAT_MS)), new P.Show({ sections: [A.pulseAmbient()], drive, colours: {}, bpm: BPM }).frame(Math.round(1.5 * BEAT_MS)), 'after the moment, its own colours again');
});

test('on every snare: one layer however many hits, flashing on the snares the drive hears', () => {
  const { music, hits } = heard();
  const b = C.build({ cues: [cue('snareFlash', 0, 16), cue('kickBright', 0, 16, { zone: 'bottom' })], drive });
  assert.equal(b.anim.layers.length, 2);
  assert.deepEqual(b.anim.layers.map((l) => [l.move, l.colour]), [['snare', 6], ['kick', undefined]]);
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, music });
  const look = new P.Show({ sections: [A.pulseAmbient()], drive, colours: {}, music });
  const beatMs = (x) => {   // the drive's own clock: ms at which it has counted x beats
    const b0 = music(0).beats;
    let ms = 0; while (music(ms).beats - b0 < x * 16384) ms += 2;
    return ms;
  };
  const snares = hits.snare.filter((x) => x < 15);
  assert.ok(snares.length >= 6, `${snares.length} snares`);
  for (const s of snares) {
    const ms = beatMs(s) + 30, top = show.frame(ms)[4], was = look.frame(ms)[4];
    assert.ok(top[2] > was[2] + 60, `a white flash at the top on the snare at beat ${s.toFixed(2)}: ${top} vs ${was}`);
  }
  assert.ok(new Set(snares.map((s) => Math.round(s * 2) % 4)).size <= 2, 'the snares are on beats 2 and 4');
  assert.ok(b.bytes < 30, `${b.bytes} bytes for every snare and kick over 4 bars`);
});

test('taps on the snares the drive hears fold into one "on every snare" cue', () => {
  const { hits } = heard();
  const onSnares = hits.snare.filter((x) => x >= 4 && x < 20).map((x) => cue('white', C.snapTo(x, 0.25), 0.5));
  assert.equal(onSnares.length, 8);
  const others = [cue('shimmer', 1, 1), cue('white', 2.6, 0.5)];
  const offers = C.foldOffers([...others, ...onSnares], hits);
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].indexes, onSnares.map((_, i) => i + 2));
  assert.match(offers[0].text, /^Turn these 8 white pulses into: white pulse on every snare, bar 2 to bar 5$/);
  assert.equal(offers[0].cue.kind, 'snareFlash');
  assert.deepEqual(offers[0].cue.colour, WHITE);
  const folded = C.fold([...others, ...onSnares], offers[0]);
  assert.equal(folded.length, 3);
  assert.ok(folded[2].at <= onSnares[0].at && folded[2].at + folded[2].for >= onSnares.at(-1).at + 0.5);
  // brightness pulses on the kicks fold too, keeping their LEDs
  const onKicks = hits.kick.filter((x) => x >= 0 && x < 16).map((x) => cue('bright', C.snapTo(x, 0.25), 0.5, { zone: 'top' }));
  const k = C.foldOffers(onKicks, hits);
  assert.equal(k.length, 1);
  assert.match(k[0].text, new RegExp(`^Turn these ${onKicks.length} brightness pulses into: brightness pulse on every kick \\(top LEDs\\)`));
  assert.equal(k[0].cue.kind, 'kickBright');
  assert.equal(k[0].cue.zone, 'top');
  // no offer: 3 in a row, a snare skipped, taps between the hits, mixed colours
  assert.deepEqual(C.foldOffers(onSnares.slice(0, 3), hits), []);
  const skipped = C.foldOffers([...onSnares.slice(0, 3), ...onSnares.slice(4)], hits);
  assert.deepEqual(skipped.map((o) => o.indexes.length), [4], 'only the 4 after the gap');
  assert.deepEqual(C.foldOffers(onSnares.map((c) => ({ ...c, at: c.at + 0.5 })), hits), []);
  assert.deepEqual(C.foldOffers(onSnares.map((c, i) => ({ ...c, kind: 'stutter', colour: i % 2 ? GREEN : WHITE })), hits), []);
});

test('what\'s under the cues, kept in the browser: old cues ({ colour, level }) still read', () => {
  assert.equal(C.underMode({ colour: ORANGE, level: 0 }), 'dark');
  assert.equal(C.underMode({ colour: ORANGE, level: 20 }), 'colour');
  assert.equal(C.underMode(undefined), 'normal');
  assert.deepEqual(C.cleanUnder({ mode: 'recolour', colours: { 1: [1, 2, 3], 2: 'red', 7: [1, 1, 1] } }), { mode: 'recolour', colour: [255, 255, 255], level: 30, colours: { 1: [1, 2, 3] } });
  assert.deepEqual(C.cleanUnder(null), { mode: 'normal' });
  assert.equal(C.cleanCues([cue('snareFlash', 0, 4)]).length, 1);
});
