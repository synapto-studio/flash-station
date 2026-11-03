// Squeezing an animation for the drive (js/squeeze.js, 3 Nov 2026): fewer layers and bytes, the
// same light on every LED in every frame, using only what a drive already reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/cues.js';
import * as P from '../js/player.js';
import { squeeze, sameFrames } from '../js/squeeze.js';
import { defaultProfile } from '../js/profiles.js';
import { demoMissing } from '../js/show.js';

const drive = P.makeDrive(defaultProfile('pulse'));
const ANY = { most: Infinity };
const WHITE = [255, 255, 255], BLUE = [0, 80, 255], GREEN = [159, 255, 82];

// Every LED at random times (not on squeeze's own 1/32-beat grid), with random kicks and snares,
// over a made-up normal look: an independent check of the frames.
function framesMatch(a, b, seed = 1) {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const len = P.length(a) * 16384, pal = P.palette({ red: [255, 30, 0], orange: [255, 120, 0], white: [200, 220, 255] });
  const under = drive.heights.map((_, i) => ({ c: [40 * i, 255 - 30 * i, 90], l: 30 + 25 * i }));
  for (let k = 0; k < 4000; k++) {
    const t = Math.floor(rnd() * (len + 2000));
    const music = { bar: t & 65535, beats: t, kick: Math.floor(rnd() * 256), snare: Math.floor(rnd() * 256), loud: Math.floor(800 + rnd() * 1000) };
    const ctx = { drive, palette: pal, music, ...(a.over ? { under } : {}) };
    const x = P.levels(a, t, ctx), y = P.levels(b, t, ctx);
    for (let i = 0; i < x.length; i++) if (x[i].l !== y[i].l || x[i].c.join() !== y[i].c.join()) return `t ${t}, LED ${i + 1}: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i])}`;
  }
  return null;
}
const recipeOf = (layers, more = {}) => ({ type: 'animation', name: 'T', board: 'pulse', timing: 'beats', once: true, over: true, custom: [WHITE, BLUE], layers, ...more });
const flash = (at, len, more = {}) => ({ move: 'fade', leds: 'all', at, for: len, colour: [6, 6], level: [255, 0], curve: 'out', blend: 'flash', ...more });

test('the same effect at other times, on another layer: one layer that plays again', () => {
  const r = recipeOf([flash(0, 0.5), { move: 'kick', leds: 'all', at: 16, for: 16, loud: 60, colour: 7 }, flash(8, 0.5), flash(12, 0.5)]);
  const s = squeeze(r, { drive });
  assert.ok(s.squeezed);
  assert.equal(s.before.layers, 4);
  assert.equal(s.layers, 2, 'the three flashes are one layer');
  assert.ok(s.bytes < s.before.bytes, `${s.before.bytes} -> ${s.bytes} bytes`);
  const f = s.anim.layers.find((l) => l.move === 'fade');
  assert.deepEqual([f.at, ...f.again], [0, 8, 12]);
  assert.equal(framesMatch(P.normalise(r), s.anim), null);
});

test('not when a layer between them lights the same LEDs at the same time (the one on top stays on top)', () => {
  // a blue tint over the first flash (drawn after it), then the same flash again over the tint
  const tint = { move: 'fade', leds: 'all', at: 0, for: 16, colour: [7, 7], level: [255, 255], blend: 'tint' };
  const r = recipeOf([flash(0, 0.5), tint, flash(8, 0.5)]);
  const s = squeeze(r, { drive });
  assert.equal(s.layers, 3, 'merging would put one flash under the tint or the other over it');
  assert.equal(framesMatch(P.normalise(r), s.anim), null);
  // on other LEDs it's fine
  const r2 = recipeOf([flash(0, 0.5), { ...tint, leds: [5, 6] }, flash(8, 0.5, { leds: [1, 2, 3, 4, 7, 8] }), flash(4, 0.5, { leds: [1, 2, 3, 4, 7, 8] })]);
  const s2 = squeeze(r2, { drive });
  assert.equal(s2.layers, 3);
  assert.equal(framesMatch(P.normalise(r2), s2.anim), null);
});

test('not copies that overlap (a layer that plays again starts over), nor past 64 times', () => {
  const r = recipeOf([flash(0, 2), flash(1, 2, { leds: [5, 6] })].map((l) => ({ ...l, leds: [5, 6] })));
  assert.equal(squeeze(r, { drive }).layers, 2);
  const many = recipeOf(Array.from({ length: 70 }, (_, i) => flash(i, 0.5)).slice(0, 15));
  const s = squeeze(many, { drive });
  assert.equal(s.layers, 1);
  // 70 copies (built with "again" already) and one more: no room in one layer
  const full = { ...flash(0, 0.5), again: Array.from({ length: 64 }, (_, i) => i + 1) };
  const s2 = squeeze(recipeOf([full, flash(80, 0.5)]), { drive });
  assert.equal(s2.layers, 2);
});

test('the order that takes the fewest bytes, keeping layers that clash in order', () => {
  // the bottom zone, the top, the bottom, the top: the same LEDs side by side lose their LED bytes
  const bottom = [1, 2, 7, 8], top = [5, 6];
  const r = recipeOf([flash(0, 1, { leds: bottom }), flash(4, 1, { leds: top, level: [200, 0] }), flash(2, 1, { leds: bottom, level: [180, 0] }), flash(6, 1, { leds: top, level: [160, 0] })]);
  const s = squeeze(r, { drive });
  assert.ok(s.bytes < s.before.bytes, `${s.before.bytes} -> ${s.bytes}`);
  assert.equal(framesMatch(P.normalise(r), s.anim), null);
  // a cut over a flash at the same time stays over it
  const cut = { move: 'glow', leds: 'all', at: 0, for: 1, colour: 0, level: 0 };
  const s2 = squeeze(recipeOf([flash(0, 1), flash(0, 1, { leds: top, level: [90, 0] }), cut]), { drive });
  assert.equal(s2.anim.layers[s2.anim.layers.length - 1].move, 'glow');
  assert.equal(framesMatch(P.normalise(recipeOf([flash(0, 1), flash(0, 1, { leds: top, level: [90, 0] }), cut])), s2.anim), null);
});

test('sameFrames sees a real difference', () => {
  const tint = { move: 'fade', leds: 'all', at: 0, for: 4, colour: [7, 7], level: [255, 255], blend: 'tint' };
  const a = P.normalise(recipeOf([flash(0, 1), tint])), b = P.normalise(recipeOf([tint, flash(0, 1)]));
  assert.equal(sameFrames(a, b, drive), false);
  assert.equal(sameFrames(a, a, drive), true);
  assert.notEqual(framesMatch(a, b), null);
});

test('Light cues: a timeline of separate looks squeezes into far fewer layers, and plays the same', () => {
  // as the editor makes it: white pulses recorded at different lengths that come in over a 16th, the
  // same look again on a second layer, two Recolours with the same colours, kick flashes, cuts
  const t = C.emptyTracks();
  const row = (kind, name) => { t.rows.push(C.newRow(t, kind, name)); return t.rows.length - 1; };
  const w = row('white'), w2 = row('white', 'White pulse 2'), rc = row('recolour'), k = row('kickFlash'), cut = row('cut'), sw = row('bright');
  const wl = (len) => ({ ...C.defaultLook('white'), for: len, in: 0.0625 });
  [[0, 0.5], [4, 1], [8, 0.5], [12, 2], [16, 0.5], [20, 1]].forEach(([a, l]) => C.place(t, w, a, wl(l)));
  [[32, 0.5], [36, 1], [40, 0.5]].forEach(([a, l]) => C.place(t, w2, a, wl(l)));
  C.place(t, rc, 0, { ...C.defaultLook('recolour'), for: 16 });
  C.place(t, rc, 32, { ...C.defaultLook('recolour'), for: 12 });
  C.place(t, k, 0, { ...C.defaultLook('kickFlash'), colour: BLUE, for: 16 });
  C.place(t, cut, 15.5, C.defaultLook('cut'));
  C.place(t, cut, 47.5, C.defaultLook('cut'));
  C.place(t, sw, 24, { ...C.defaultLook('bright'), sweep: 'up', for: 2 });
  const b = C.buildTracks({ tracks: t, drive });
  assert.equal(b.before.layers, 31);
  assert.equal(b.layers, 19);
  assert.ok(b.bytes <= b.before.bytes - 40, `${b.before.bytes} -> ${b.bytes} bytes`);
  assert.ok(b.tooMany, 'still more than 15: the screen says so');
  const raw = P.normalise(C.tracksRecipe({ tracks: t, drive }), ANY);
  assert.equal(framesMatch(raw, b.anim), null);
  // each row's tag: the layers it makes before squeezing (they add up)
  const n = C.rowLayers(t, drive);
  assert.equal(Object.values(n).reduce((x, y) => x + y, 0), 31);
  assert.equal(n[t.rows[rc].id], 18, 'two Recolours, 3 colours, in, hold and out: 18');
  // without the second Recolour and the sweep it fits: the drive can have it
  t.rows[sw].muted = true;
  t.rows[rc].groups.pop();
  const fit = C.buildTracks({ tracks: t, drive });
  assert.ok(!fit.tooMany, `${fit.layers} layers`);
  assert.equal(framesMatch(P.normalise(C.tracksRecipe({ tracks: t, drive }), ANY), fit.anim), null);
  // what goes to the drive: its bytes read back as the same animation, and the demo plays every move
  assert.deepEqual(P.unpack(P.pack(fit.recipe), { name: fit.anim.name, board: 'pulse' }).layers, fit.anim.layers);
  assert.deepEqual(demoMissing(fit.recipe), []);
  assert.ok(fit.recipe.tracks, 'the timeline is still in the recipe');
});

test('random timelines: squeezed, every LED of every frame is the same', () => {
  let r = 7;   // (mulberry32)
  const rnd = (n) => { r = (r + 0x6d2b79f5) | 0; let x = Math.imul(r ^ (r >>> 15), 1 | r); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n); };
  const kinds = Object.keys(C.KINDS), colours = [WHITE, BLUE, GREEN, [255, 0, 60]], lens = [0.25, 0.5, 1, 2, 4];
  let squeezedSome = 0, fewer = 0;
  const errs = [];
  for (let k = 0; k < (Number(process.env.SQ_MANY) || 40); k++) {
    const t = C.emptyTracks();
    if (k % 5 === 4) t.under = { mode: 'dark' };
    for (let n = 2 + rnd(4); n; n--) {
      const kind = kinds[rnd(kinds.length)];
      t.rows.push(C.newRow(t, kind));
      const ri = t.rows.length - 1, looks = 1 + rnd(2);
      for (let g = 0; g < looks; g++) {
        const look = { ...C.defaultLook(kind), for: kind === 'recolour' ? 4 + rnd(8) : lens[rnd(lens.length)], colour: colours[rnd(colours.length)], zones: [['top', 'middle', 'bottom'], ['top'], ['bottom'], ['middle', 'top']][rnd(4)] };
        if (C.KINDS[kind].shape) { look.in = [0, 0, 0.0625, 0.125][rnd(4)]; if (rnd(4) === 0 && look.for >= 2) look.sweep = 'up'; }
        for (let c = 1 + rnd(4); c; c--) C.place(t, ri, rnd(32), look);
      }
    }
    let b;
    try { b = C.buildTracks({ tracks: t, drive }); } catch (e) { errs.push(e.message); continue; }   // (some random looks can't be made: too many colours)
    const raw = P.normalise(C.tracksRecipe({ tracks: t, drive }), ANY);
    assert.ok(!b.failed);
    assert.equal(framesMatch(raw, b.anim, k + 1), null, `timeline ${k}`);
    if (b.before.bytes > b.bytes) squeezedSome++;
    if (b.before.layers > b.layers) fewer++;
  }
  if (process.env.SQ_MANY) console.log(`${squeezedSome} smaller, ${fewer} fewer`);
  assert.ok(squeezedSome >= 10 && fewer >= 5, `${squeezedSome} smaller, ${fewer} with fewer layers; ${errs.length} couldn't be made: ${errs.slice(0, 3).join(' / ')}`);
});
