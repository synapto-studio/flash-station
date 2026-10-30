// Light cues (R8, R9, R10): effects on a timeline become a beat-timed one-shot recipe a Pulse can play
// as a song moment's animation. The screen (js/cues-tab.js) is checked in headless Chromium.
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

test('at most 15 layers: cues that look the same are one (linked), each other one its own; about 7 to 13 bytes each', () => {
  const many = Array.from({ length: 16 }, (_, i) => cue('white', i, 0.5, { level: 40 + i }));   // all different
  assert.throws(() => C.build({ cues: many, drive }), /one animation can have 15/);
  assert.equal(C.build({ cues: many.slice(0, 15), drive }).anim.layers.length, 15, 'over the normal look: no layer for what\'s under');
  assert.equal(C.build({ cues: many.slice(0, 15), drive, under: { mode: 'dark' } }).anim.layers.length, 15);
  assert.throws(() => C.build({ cues: many.slice(0, 15), drive, under: { mode: 'colour', colour: ORANGE, level: 20 } }), /one animation can have 15/);
  assert.equal(C.build({ cues: many.slice(0, 14), drive, under: { colour: ORANGE, level: 20 } }).anim.layers.length, 15);
  const same = C.build({ cues: Array.from({ length: 16 }, (_, i) => cue('white', i, 0.5)), drive });
  assert.equal(same.anim.layers.length, 1, '16 that look the same: one layer that plays again');
  assert.equal(same.anim.layers[0].again.length, 15);
  const one = C.build({ cues: [cue('white', 0, 0.5)], drive }).bytes;
  const two = C.build({ cues: [cue('white', 0, 0.5), cue('cut', 1, 0.5)], drive }).bytes;
  assert.ok(two - one >= 4 && two - one <= 13, `a cut costs ${two - one} bytes`);
  // a typical burst of 8 different cues fits on the demo next to Poison's moment
  const burst = C.build({ cues: ['white', 'cut', 'shimmer', 'stutter', 'white', 'fadeUp', 'fadeDown', 'bright'].map((k, i) => cue(k, i, 1, { level: 90 + i })), drive });
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

test('R9\'s "normal look in new colours" opens as a Recolour over the cues: top and middle the new red, bottom the new orange', () => {
  const BLUE = [0, 40, 255], PINK = [255, 0, 140];
  const t = C.cuesToTracks([cue('bright', 0, 1)], { mode: 'recolour', colours: { 1: BLUE, 2: PINK } });
  assert.deepEqual(t.rows.map((r) => r.kind), ['bright', 'recolour'], 'the Recolour at the bottom, under the cues');
  const look = t.rows[1].groups[0].look;
  assert.deepEqual([look.paint.top.colour, look.paint.middle.colour, look.paint.bottom.colour], [BLUE, BLUE, PINK]);
  assert.deepEqual([t.rows[1].groups[0].at, look.for, look.in, look.out], [[0], 1, 0, 0]);
  const b = C.buildTracks({ tracks: t, drive });
  assert.equal(b.recipe.recolour, undefined, 'no recolour byte: tints');
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, bpm: BPM });
  const px = show.frame(Math.round(0.5 * BEAT_MS));
  assert.ok(px[2][2] > 30 && px[2][0] === 0, `the middle, red in the look, is blue: ${px[2]}`);
  assert.ok(px[0][2] > px[0][1] && px[0][0] > 20, `the bottom pink: ${px[0]}`);
  assert.equal(P.length(b.anim), 1);
  assert.deepEqual(show.frame(Math.round(1.5 * BEAT_MS)), new P.Show({ sections: [A.pulseAmbient()], drive, colours: {}, bpm: BPM }).frame(Math.round(1.5 * BEAT_MS)), 'after the moment, its own colours again');
});

test('on every snare: one layer however many hits, flashing on the snares the drive hears', () => {
  const { music, hits } = heard();
  const b = C.build({ cues: [cue('snareFlash', 0, 16), cue('kickBright', 0, 16, { zone: 'bottom' })], drive });
  assert.equal(b.anim.layers.length, 2);
  assert.deepEqual(b.anim.layers.map((l) => [l.move, l.colour]).sort(), [['kick', undefined], ['snare', 6]]);
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
  assert.deepEqual(C.cleanUnder({ mode: 'recolour', colours: { 1: [1, 2, 3], 2: 'red', 7: [1, 1, 1] } }), { mode: 'normal', colour: [255, 255, 255], level: 30, colours: { 1: [1, 2, 3] } }, 'R9\'s new colours: the normal look (and a Recolour)');
  assert.deepEqual(C.cleanUnder(null), { mode: 'normal', colour: [255, 255, 255], level: 30, colours: {} });
  assert.equal(C.cleanCues([cue('snareFlash', 0, 4)]).length, 1);
});

// ---------------------------------------------------------------- R10a: Recolour, R10b: tracks
const BLUE = [0, 60, 255];
const tracksWith = (...rows) => ({ under: { mode: 'normal', colour: WHITE, level: 30 }, rows });
const row = (kind, groups, more = {}) => ({ id: kind + groups.length, name: C.KINDS[kind].name, kind, muted: false, groups, ...more });
const recolourLook = (more = {}) => ({ ...C.defaultLook('recolour'), for: 8, in: 0, out: 0,
  paint: { top: { colour: BLUE, level: 100 }, middle: { colour: BLUE, level: 100 }, bottom: { colour: BLUE, level: 100 } }, ...more });
function playTracks(tracks, music) {
  const b = C.buildTracks({ tracks, drive });
  const opts = music ? { music } : { bpm: BPM };
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, ...opts });
  const look = new P.Show({ sections: [A.pulseAmbient()], drive, colours: {}, ...opts });
  const ms = (beats) => Math.round(beats * (music ? 0 : BEAT_MS));
  return { ...b, show, look, ms };
}
const blueish = (c) => c[2] > 0 && c[0] <= c[2] * 0.05 + 1 && c[1] <= c[2] * 0.25 + 1;

test('R10a Recolour: all 8 LEDs take the new colour over exactly its stretch, the look moving under it; nothing else changes', () => {
  const t = tracksWith(row('recolour', [{ at: [4], look: recolourLook() }]));
  const { show, look, anim } = playTracks(t);
  const at = (sh, b) => sh.frame(Math.round(b * BEAT_MS));
  assert.deepEqual(demoMissing(anim), []);
  for (const b of [0, 1, 2, 3.9]) assert.deepEqual(at(show, b), at(look, b), `before it, the look: beat ${b}`);
  let moved = 0;
  for (let b = 4.05; b < 12; b += 0.25) {
    const px = at(show, b), was = at(look, b);
    px.forEach((c, i) => assert.ok(blueish(c), `LED ${i + 1} blue at beat ${b}: ${c}`));
    // the level is the look's: the brightest channel of blue follows the look's brightest
    px.forEach((c, i) => { const lv = Math.max(...was[i]); assert.ok(Math.abs(c[2] * 255 / BLUE[2] - lv) <= 3 + lv * 0.03, `LED ${i + 1} as bright as the look at beat ${b}: ${c} vs ${was[i]}`); });
    if (b > 4 && px[4][2] !== at(show, b - 0.25)[4][2]) moved++;
  }
  assert.ok(moved >= 4, `the top pulse keeps moving under it (${moved})`);
  assert.equal(P.length(anim), 12);
  // zones not ticked are left as the look
  const top = tracksWith(row('recolour', [{ at: [0], look: recolourLook({ zones: ['top'] }) }]));
  const p2 = playTracks(top), f = p2.show.frame(Math.round(2 * BEAT_MS)), l2 = p2.look.frame(Math.round(2 * BEAT_MS));
  assert.ok(blueish(f[4]) && blueish(f[5]));
  assert.deepEqual([0, 1, 2, 3, 6, 7].map((k) => f[k]), [0, 1, 2, 3, 6, 7].map((k) => l2[k]));
});

test('R10a Recolour: the look\'s kicks lift in the new colour; brightness per zone (darker to 100 %, a lift above); fades in and out', (tc) => {
  // a loud steady beat with a hard kick on each beat (the ambient's kicks lift its LEDs)
  const music = (ms) => ({ ...P.steadyMusic(ms, BPM), kick: ms % BEAT_MS < 40 ? 255 : 0, loud: 1800 });
  const t = tracksWith(row('recolour', [{ at: [0], look: recolourLook({ for: 16 }) }]));
  const b = C.buildTracks({ tracks: t, drive });
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, music });
  const look = new P.Show({ sections: [A.pulseAmbient()], drive, colours: {}, music });
  for (let beat = 1; beat < 15; beat += 3) {
    const on = Math.round(beat * BEAT_MS + 20), off = Math.round(beat * BEAT_MS + 300);
    const kick = show.frame(on)[0], rest = show.frame(off)[0], lookKick = look.frame(on)[0];
    assert.ok(Math.max(...lookKick) > Math.max(...look.frame(off)[0]) + 40, `the look's bottom lifts on the kick at beat ${beat}`);
    assert.ok(blueish(kick) && blueish(rest), `in blue: ${kick}, ${rest}`);
    assert.ok(kick[2] > rest[2] + 40 && Math.abs(kick[2] - Math.max(...lookKick)) <= 6, `the kick lifts it as it lifts the look: ${kick} vs ${lookKick}`);
  }
  // brightness: top 100 %, middle 70 % (70 % of the light), bottom 200 % (a lift to full)
  const zoned = tracksWith(row('recolour', [{ at: [0], look: recolourLook({ paint: { top: { colour: BLUE, level: 100 }, middle: { colour: BLUE, level: 70 }, bottom: { colour: BLUE, level: 200 } } }) }]));
  const z = playTracks(zoned), ms = Math.round(2 * BEAT_MS), px = z.show.frame(ms), lk = z.look.frame(ms);
  assert.ok(Math.abs(px[2][2] - Math.round(Math.max(...lk[2]) * 0.7)) <= 3, `middle at 70 %: ${px[2]} (the look ${lk[2]})`);
  assert.equal(px[0][2], 255, `bottom lifted to full: ${px[0]}`);
  assert.ok(Math.abs(px[4][2] - Math.max(...lk[4])) <= 3, `top as the look: ${px[4]}`);
  assert.equal(z.anim.layers.length, 4, 'three tints (one each) and a lift');
  // fades: in over 2 beats, out over 2: halfway in, the middle is between the look's red and blue
  const faded = playTracks(tracksWith(row('recolour', [{ at: [0], look: recolourLook({ in: 2, out: 2 }) }])));
  const mid = faded.show.frame(Math.round(1 * BEAT_MS))[2], end = faded.show.frame(Math.round(7 * BEAT_MS))[2];
  assert.ok(mid[0] > 5 && mid[2] > 5, `halfway in: red and blue ${mid}`);
  assert.ok(end[0] > 5 && end[2] > 5, `halfway out: ${end}`);
  assert.ok(blueish(faded.show.frame(Math.round(4 * BEAT_MS))[2]), 'held in between');
  const one = C.buildTracks({ tracks: t, drive }), three = faded;
  assert.equal(one.anim.layers.length, 1, 'one colour everywhere, no fades: one layer');
  assert.equal(three.anim.layers.length, 3, 'with fades: in, held, out');
  // Jonny's example: top light blue 100 %, middle deep blue 70 %, bottom blue 85 %, fading in and out
  const jonny = C.buildTracks({ tracks: tracksWith(row('recolour', [{ at: [8], look: { ...C.defaultLook('recolour'), for: 16, paint: { top: { colour: [90, 170, 255], level: 100 }, middle: { colour: [0, 30, 255], level: 70 }, bottom: { colour: [0, 80, 255], level: 85 } } } }])), drive });
  assert.equal(jonny.layers, 9);
  assert.ok(jonny.bytes <= C.DEMO_ROOM, `${jonny.bytes} bytes`);
  tc.diagnostic(`Recolour bytes: one colour ${one.bytes}, with fades ${three.bytes}, Jonny's three blues with fades ${jonny.bytes} (${jonny.layers} layers)`);
});

test('R10b tracks: linked copies are one layer played again; separate, mute, order, zones', () => {
  const t = tracksWith(row('white', []), row('cut', []));
  const w = C.place(t, 0, 0, C.defaultLook('white'));
  for (const b of [1, 2, 3]) C.copyClip(t, w, b);
  assert.deepEqual(t.rows[0].groups[0].at, [0, 1, 2, 3]);
  C.place(t, 1, 1, C.defaultLook('cut', { zones: ['bottom'] }));
  let b = C.buildTracks({ tracks: t, drive });
  assert.equal(b.layers, 2, '4 linked white pulses and a cut: 2 layers');
  assert.deepEqual(b.anim.layers.map((l) => l.move), ['glow', 'fade'], 'the cut (lower row) first, the white pulses over it');
  assert.deepEqual(b.anim.layers[1].again, [1, 2, 3]);
  // the top row draws over: at beat 1 the bottom flashes white over the cut
  const show = new P.Show({ sections: [b.anim], under: A.pulseAmbient(), drive, colours: {}, bpm: BPM });
  assert.ok(show.frame(Math.round(1.02 * BEAT_MS))[0].every((v) => v > 150), `white over the cut: ${show.frame(Math.round(1.02 * BEAT_MS))[0]}`);
  C.moveRow(t, 0, 1);
  const show2 = new P.Show({ sections: [C.buildTracks({ tracks: t, drive }).anim], under: A.pulseAmbient(), drive, colours: {}, bpm: BPM });
  assert.ok(dark([show2.frame(Math.round(1.02 * BEAT_MS))[0]]), 'the cut over the white');
  C.moveRow(t, 1, -1);
  // change one: all change (linked); make one separate: its own layer
  C.setLook(t, { row: 0, group: 0, i: 2 }, { level: 50 });
  assert.ok(t.rows[0].groups[0].look.level === 50 && t.rows[0].groups.length === 1);
  const sep = C.separate(t, { row: 0, group: 0, i: 2 });
  C.setLook(t, sep, { level: 80, zones: ['top', 'bottom'] });
  b = C.buildTracks({ tracks: t, drive });
  assert.equal(b.layers, 3);
  assert.deepEqual(b.anim.layers[2].leds, [1, 2, 5, 6, 7, 8], 'top and bottom ticked');
  assert.equal(b.anim.layers[2].at, 2);
  // muted: left out of the animation and the bytes
  t.rows[1].muted = true;
  const m = C.buildTracks({ tracks: t, drive });
  assert.equal(m.layers, 2);
  assert.ok(m.bytes < b.bytes);
  t.rows[0].muted = true;
  assert.throws(() => C.buildTracks({ tracks: t, drive }), /Nothing to play/);
  // placing the same look again joins the copies (recording taps)
  const r = tracksWith(row('white', []));
  for (const x of [0, 0.5, 1]) C.place(r, 0, x, C.defaultLook('white'));
  C.place(r, 0, 2, C.defaultLook('white', { for: 1 }));
  assert.equal(r.rows[0].groups.length, 2, 'taps alike are linked; a longer one is its own');
  // deleting copies
  C.deleteClip(r, { row: 0, group: 1, i: 0 });
  assert.equal(r.rows[0].groups.length, 1);
  const moved = C.moveClip(r, { row: 0, group: 0, i: 0 }, 3);
  assert.deepEqual(r.rows[0].groups[0].at, [0.5, 1, 3]);
  assert.equal(moved.i, 2);
});

test('R10b shapes: how it comes in, the curve it fades out with, and a sweep up or down the drive', () => {
  const plain = C.buildTracks({ tracks: tracksWith(row('white', [{ at: [0], look: { ...C.defaultLook('white'), for: 2 } }])), drive });
  assert.equal(plain.layers, 1);
  // comes in over half a beat, then fades out
  const inT = tracksWith(row('white', [{ at: [0], look: { ...C.defaultLook('white'), for: 2, in: 0.5, curve: 'linear' } }]));
  const p = playTracks(inT), lvl = (b) => Math.max(...p.show.frame(Math.round(b * BEAT_MS))[2]);
  assert.equal(p.layers, 2);
  assert.ok(lvl(0.1) < lvl(0.3) && lvl(0.3) < lvl(0.5), `rising: ${lvl(0.1)} ${lvl(0.3)} ${lvl(0.5)}`);
  assert.ok(lvl(1.25) < lvl(0.6), 'then fading');
  // a sweep up: the bottom flashes first, the top later; down: the other way
  for (const [sweep, first, later] of [['up', 0, 4], ['down', 4, 0]]) {
    const s = playTracks(tracksWith(row('white', [{ at: [0], look: { ...C.defaultLook('white'), for: 2, sweep, spread: 1 } }])));
    assert.deepEqual(s.anim.layers.map((l) => [l.move, l.blend]), [['pulse', 'tint'], ['pulse', 'lift']], 'a tint and a lift: the flash blend, swept');
    assert.ok(!s.anim.layers[0].locked && 65536 % (s.anim.layers[0].every * 16384) !== 0, 'one pulse, not following the bar');
    const at = (b) => s.show.frame(Math.round(b * BEAT_MS)), look = (b) => s.look.frame(Math.round(b * BEAT_MS));
    assert.ok(at(0.05)[first].every((v) => v > 200), `${sweep}: LED ${first + 1} flashes at once`);
    assert.deepEqual(at(0.05)[later], look(0.05)[later], `${sweep}: LED ${later + 1} not yet`);
    assert.ok(Math.min(...at(1.05)[later]) > 150, `${sweep}: LED ${later + 1} a beat later`);
    assert.deepEqual(demoMissing(s.anim), []);
  }
  // fades: the curve; a brightness pulse sweeps as a lift
  const fu = C.buildTracks({ tracks: tracksWith(row('fadeUp', [{ at: [0], look: { ...C.defaultLook('fadeUp', { colour: GREEN }), curve: 'in' } }])), drive });
  assert.equal(fu.anim.layers[0].curve, 'in');
  const br = C.buildTracks({ tracks: tracksWith(row('bright', [{ at: [0], look: { ...C.defaultLook('bright'), for: 1, sweep: 'up' } }])), drive });
  assert.deepEqual(br.anim.layers.map((l) => [l.move, l.blend]), [['pulse', 'lift']]);
  assert.throws(() => C.buildTracks({ tracks: tracksWith(row('white', [{ at: [0], look: { ...C.defaultLook('white'), for: 0.5, sweep: 'up', spread: 1 } }])), drive }), /too short/);
});

test('R10b: tracks go in the recipe and come back from a saved animation; 30 white pulses fit the demo', (tc) => {
  const t = tracksWith(
    row('white', [{ at: Array.from({ length: 30 }, (_, i) => i), look: C.defaultLook('white', { zones: ['top'] }) }], { name: 'Every beat' }),
    row('cut', [{ at: [8.5], look: C.defaultLook('cut') }], { muted: true }),
    row('recolour', [{ at: [4], look: recolourLook({ in: 1, out: 1, for: 16 }) }]));
  const b = C.buildTracks({ name: 'Poison cues', tracks: t, drive });
  const saved = L.readRecipe(L.recipeText(L.makeAnimation(b.recipe, 'Poison cues'))).recipe;
  assert.deepEqual(C.cleanTracks(saved.tracks), C.cleanTracks(t), 'the same tracks back');
  assert.deepEqual(P.pack(saved), P.pack(b.recipe), 'and the same bytes');
  assert.equal(C.cleanTracks(saved.tracks).rows[1].muted, true, 'muted kept');
  assert.ok(b.bytes <= C.DEMO_ROOM, `30 white pulses and a Recolour: ${b.bytes} bytes of ${C.DEMO_ROOM}`);
  tc.diagnostic(`30 white pulses (one layer) and a Recolour with fades: ${b.bytes} bytes, ${b.layers} layers`);
  // bad tracks are left out, not trusted
  assert.equal(C.cleanTracks({ rows: [{ kind: 'nope', groups: [] }, { kind: 'white', groups: [{ at: [-1, 'x'], look: {} }] }] }).rows[0].groups.length, 0);
  assert.equal(C.cleanTracks('rows'), null);
});

test('R10b: a timeline saved to the library\'s animations/ keeps its tracks and is listed to open again', async () => {
  const { Library, MemoryStore } = await import('../js/library.js');
  const lib = new Library(new MemoryStore());
  const t = tracksWith(row('white', [{ at: [0, 1, 2], look: C.defaultLook('white') }], { name: 'Pulses' }), row('cut', [{ at: [3], look: C.defaultLook('cut') }], { muted: true }));
  const b = C.buildTracks({ name: 'Drop cues', tracks: t, drive });
  await lib.saveAnimation(b.recipe, 'Drop cues');
  const [back] = (await lib.animations('pulse')).filter((a) => a.tracks);
  assert.equal(back.name, 'Drop cues');
  assert.deepEqual(C.cleanTracks(back.tracks), C.cleanTracks(t));
  assert.deepEqual(P.pack(back), P.pack(b.recipe));
});
