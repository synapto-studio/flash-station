// Light cues (R8, R9, R10): a timeline of effects over a song moment. Each row (a "layer" on
// screen) has one effect (a white pulse, a shimmer, a cut to dark, a fade, a flash on every snare,
// a Recolour...) placed at one or more times; rows higher up draw over lower ones. Copies of an
// effect are linked (the same settings: change one, all change), so they're one layer of the
// recipe that plays again at each copy's time (js/player.js "again", R10c). The whole timeline is a
// beat-timed one-shot recipe a Pulse plays as a song moment's animation, over the drive's normal
// look (R9) or over dark or a colour. The screen is js/cues-tab.js; this file is the maths.
//
//   tracks: { under: { mode: 'normal' | 'dark' | 'colour', colour, level },
//             rows: [{ id, name, kind, muted, groups: [{ at: [beats, ...], look }] }] }   (rows[0] on top)
//   look:   { for, zones: ['top', 'middle', 'bottom'], colour: [r, g, b], level (%),
//             in (beats it takes to come in), curve (how it fades out), sweep ('none' | 'up' | 'down'),
//             spread (beats the sweep takes to cross the drive),
//             paint: { top: { colour, level }, ... } and out (Recolour only: its fade out) }
//   Times are beats from the start of the animation (steps of 1/16).
//
// Older saved cues (R8, R9: a list of { kind, at, for, zone, colour, level } and what's under them)
// open as tracks (cuesToTracks): "Normal look in new colours" becomes a Recolour over their length.

import { normalise, pack } from './player.js';
import { squeeze } from './squeeze.js';

export const MAX_LAYERS = 15;        // a recipe's most layers: what the placed effects become
export const MAX_CUES = MAX_LAYERS;  // (R8, R9: one layer a cue)
export const UNDER = { normal: 'Normal look', dark: 'Dark', colour: 'A colour' };
// What's under the cues; cues saved before R9 have { colour, level } (dark at level 0), and R9's
// "Normal look in new colours" ({ mode: 'recolour' }) is the normal look with a Recolour (R10a).
export const underMode = (u) => (!u ? 'normal' : u.mode === 'recolour' ? 'normal' : UNDER[u.mode] ? u.mode : u.level > 0 ? 'colour' : 'dark');
export const isOver = (u) => underMode(u) === 'normal';
// The colour set's colours the normal look (js/animations.js pulseAmbient) uses: red and orange.
export const LOOK_COLOURS = { 1: 'Red', 2: 'Orange' };
const HIT_LOUD = 60; // dB: kick and snare cues flash whenever the drive hears them (it recognised the song)
export const STEP = 1 / 16;          // the recipe's finest time: 1/16 of a beat
// Room on the demo engine (firmware demo 2.3, measured with its build tools, 3 Nov 2026): its
// show has 576 bytes; the heights and normal look take 73, and each song moment its print (96 for
// 4 bars), delay and flags (7) and its animation. Next to Poison's moment (DJ orange to green 8,
// 118 bytes) there are 282 free: one more moment with an animation up to 179 bytes. A moment on its
// own on the demo can have up to 400. (Both of today's, Poison and Sleep Forever, leave 50 free.)
export const DEMO_ROOM = 179;
export const DEMO_ALONE = 400;

// key: what to press. colour: whether the effect has a colour of its own. tap: its length in beats
// when the key is only tapped (held longer, it lasts as long as the key is held). shape: it can
// come in, fade out with a curve and sweep (R10b); curve: only the curve.
export const KINDS = {
  white:   { key: 'W', name: 'White pulse',      colour: true,  white: true, tap: 0.5, shape: true, says: 'a flash that fades back to what\'s under the cues' },
  bright:  { key: 'B', name: 'Brightness pulse', colour: false, tap: 0.5, shape: true, says: 'lifts whatever is lit towards full, then fades back' },
  shimmer: { key: 'S', name: 'Shimmer',          colour: true,  white: true, tap: 1, says: 'fast flickers on every 1/32 note, rippling up the drive' },
  stutter: { key: 'T', name: 'Stutter',          colour: true,  tap: 1, says: 'chops on and off on every 16th note' },
  cut:     { key: 'X', name: 'Cut out',          colour: false, tap: 0.5, says: 'all the chosen LEDs dark' },
  fadeUp:  { key: 'F', name: 'Fade up',          colour: true,  tap: 1, curve: true, says: 'from dark up to the colour' },
  fadeDown:{ key: 'D', name: 'Fade down',        colour: true,  tap: 1, curve: true, says: 'from the colour down to what\'s under the cues' },
  // R9: one layer however many hits; they follow what the drive hears, not the beat grid
  kickBright:  { key: 'K', name: 'Brightness pulse on every kick',  colour: false, hits: 'kick',  tap: 4, says: 'lifts whatever is lit on each kick the drive hears, for as long as the cue lasts' },
  kickFlash:   { key: null, name: 'Colour flash on every kick',     colour: true,  hits: 'kick',  tap: 4, says: 'flashes the colour on each kick the drive hears, for as long as the cue lasts' },
  snareBright: { key: 'N', name: 'Brightness pulse on every snare', colour: false, hits: 'snare', tap: 4, says: 'lifts whatever is lit on each snare the drive hears, for as long as the cue lasts' },
  snareFlash:  { key: null, name: 'Colour flash on every snare',    colour: true,  white: true, hits: 'snare', tap: 4, says: 'flashes the colour on each snare the drive hears, for as long as the cue lasts' },
  // R10a: the normal look in new colours over a stretch, each zone its own colour and brightness;
  // it keeps moving under it and its kicks pulse in the new colours
  recolour:    { key: 'R', name: 'Recolour', colour: false, tap: 16, recolour: true, says: 'the normal look in new colours for a stretch, top, middle and bottom each its own colour and brightness; its kicks pulse in the new colour' },
};
export const KIND_BY_KEY = Object.fromEntries(Object.entries(KINDS).filter(([, v]) => v.key).map(([k, v]) => [v.key, k]));
export const ZONES = ['all', 'top', 'middle', 'bottom'];
export const ZONE_NAMES = { all: 'All', top: 'Top', middle: 'Middle', bottom: 'Bottom' };
export const PARTS = ['top', 'middle', 'bottom'];   // the zones an effect can tick
export const CURVE_NAMES = { out: 'Fast, then slow', linear: 'Steady', ease: 'Smooth', in: 'Slow, then fast' };
export const SWEEPS = { none: 'No sweep', up: 'Up from the plug', down: 'Down from the logo' };

export const snapTo = (beats, step) => Math.round(beats / step) * step;
const steps = (beats) => Math.round(beats / STEP) * STEP; // what the recipe can hold
const pctLevel = (pct) => Math.max(0, Math.min(255, Math.round(Number(pct) * 2.55)));
const clone = (x) => JSON.parse(JSON.stringify(x));

// The LEDs at the top, middle and bottom of the drive, from its heights (makeDrive()): the lowest
// height is the bottom, the highest the top, the rest the middle. With more than three heights,
// the drive is split into thirds. LED numbers from 1. Pulse (estimated positions): bottom 1, 2,
// 7, 8 (front and back), middle 3, 4, top 5, 6.
export function zones(drive) {
  const h = drive.heights;
  const levels = [...new Set(h)].sort((a, b) => a - b);
  const lo = levels[0], hi = levels[levels.length - 1];
  const where = (v) => {
    if (levels.length <= 3) return v === lo ? 'bottom' : v === hi ? 'top' : 'middle';
    const f = hi === lo ? 0 : (v - lo) / (hi - lo);
    return f < 1 / 3 ? 'bottom' : f > 2 / 3 ? 'top' : 'middle';
  };
  const out = { all: h.map((_, i) => i + 1), top: [], middle: [], bottom: [] };
  h.forEach((v, i) => out[where(v)].push(i + 1));
  return out;
}
// "all", or the LEDs of the zones ticked (all three: "all")
function ledsOf(z, parts) {
  const ps = PARTS.filter((p) => parts.includes(p));
  if (!ps.length || ps.length === 3) return 'all';
  const leds = ps.flatMap((p) => z[p]).sort((a, b) => a - b);
  return leds.length ? leds : 'all';
}

// ---------------------------------------------------------------- an effect's look
// A new look for an effect of this kind: opts from the screen (zones, colour, level, for).
export function defaultLook(kind, opts = {}) {
  const k = KINDS[kind];
  const look = {
    for: opts.for || k.tap,
    zones: opts.zones ? PARTS.filter((p) => opts.zones.includes(p)) : [...PARTS],
    colour: k.white && !opts.colour ? [255, 255, 255] : opts.colour ? [...opts.colour] : [255, 255, 255],
    level: opts.level ?? 100,
    in: 0, curve: k.curve ? 'ease' : 'out', sweep: 'none', spread: 0.5,
  };
  if (k.recolour) {
    // light blue at the top, deep blue in the middle, blue at the bottom (Jonny's example, 30 Oct 2026)
    look.paint = { top: { colour: [90, 170, 255], level: 100 }, middle: { colour: [0, 30, 255], level: 100 }, bottom: { colour: [0, 80, 255], level: 100 } };
    look.in = 1; look.out = 1; look.curve = 'linear';
    look.for = Math.max(look.for, 4);
  }
  return look;
}
const sameLook = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- an effect as recipe layers
// The layers one effect is, each with its time from the effect's start in `at` (the caller adds
// the copies' times). ctx: { z (zones), slotOf (a colour's slot), over (over the normal look),
// u, uL (what's under: its slot and level) }.
function sweepPulse(base, len, rin, L, curve, lag, colour, blend) {
  // one pulse over the layer that never repeats: its every is longer than the layer, and not one
  // that lines up with the bar (1/16, 1/8 ... 4 beats follow the music's bar in the player)
  let e = Math.round(len * 16) + 1;
  while (e <= 64 && 64 % e === 0) e++;
  return { move: 'pulse', ...base, colour, low: 0, high: L, every: e / 16, rise: rin, fall: steps(len - rin - Math.abs(lag)), up: 'linear', down: curve, lag, blend };
}
export function effectLayers(kind, look, ctx) {
  const k = KINDS[kind];
  if (!k) throw new Error(`"${kind}" isn't a kind of effect.`);
  const { z, slotOf, over, u, uL } = ctx;
  const len = Math.max(STEP, steps(look.for)), L = pctLevel(look.level), leds = ledsOf(z, look.zones);
  const base = { leds, at: 0, for: len };
  if (k.recolour) return recolourLayers(look, ctx, len);
  const slot = k.colour ? slotOf(look.colour) : 0;
  if (k.hits) return [{ move: k.hits, ...base, loud: HIT_LOUD, colour: k.colour ? slot : 0 }];
  const rin = k.shape ? Math.max(0, Math.min(steps(look.in || 0), len - STEP)) : 0;
  const curve = CURVE_NAMES[look.curve] ? look.curve : 'out';
  if (k.shape && look.sweep && look.sweep !== 'none') {
    // a sweep (R10b): a pulse whose lag spreads it up or down the drive; a flash is a tint and a
    // lift together (the same sums as fade's flash blend), so it works over anything
    const spread = Math.max(STEP, steps(look.spread || 0.5));
    if (len - rin - spread < STEP) throw new Error(`${k.name} at its length (${len} beats) is too short to come in over ${rin} and sweep over ${spread}. Make it longer, or the sweep shorter.`);
    const lag = Math.min(spread, 127 * STEP) * (look.sweep === 'down' ? -1 : 1);
    if (kind === 'bright') return [sweepPulse(base, len, rin, L, curve, lag, 0, 'lift')];
    return [sweepPulse(base, len, rin, L, curve, lag, slot, 'tint'), sweepPulse(base, len, rin, L, curve, lag, slot, 'lift')];
  }
  // comes in over `in` (steady), then fades out over the rest with the curve
  const twoPart = (from, to, blend) => {
    const b = blend ? { blend } : {};
    if (!rin) return [{ move: 'fade', ...base, colour: [from.c, to.c], level: [from.l, to.l], curve, ...b }];
    return [{ move: 'fade', leds, at: 0, for: rin, colour: [to.c, from.c], level: [to.l, from.l], curve: 'linear', ...b },
      { move: 'fade', leds, at: rin, for: steps(len - rin), colour: [from.c, to.c], level: [from.l, to.l], curve, ...b }];
  };
  if (over) {
    if (kind === 'white') return twoPart({ c: slot, l: L }, { c: slot, l: 0 }, 'flash');
    if (kind === 'fadeDown') return [{ move: 'fade', ...base, colour: [slot, slot], level: [L, 0], curve, blend: 'flash' }];
    if (kind === 'fadeUp') return [{ move: 'fade', ...base, colour: [slot, slot], level: [0, L], curve, blend: 'flash' }];
  }
  switch (kind) {
    case 'white':    return twoPart({ c: slot, l: L }, { c: u, l: uL });
    case 'bright':   return twoPart({ c: 0, l: L }, { c: 0, l: 0 }, 'lift');
    case 'shimmer':  return [{ move: 'pulse', ...base, colour: slot, low: Math.round(L * 0.15), high: L, every: 0.125, rise: 0, fall: 0.125, down: 'linear', lag: 0.0625 }];
    case 'stutter':  return [{ move: 'pulse', ...base, colour: slot, low: 0, high: L, every: 0.25, rise: 0, fall: 0.125, down: 'in' }];
    case 'cut':      return [{ move: 'glow', ...base, colour: 0, level: 0 }];
    case 'fadeUp':   return [{ move: 'fade', ...base, colour: [u, slot], level: [uL, L], curve }];
    case 'fadeDown': return [{ move: 'fade', ...base, colour: [slot, u], level: [L, uL], curve }];
  }
  throw new Error(`"${kind}" isn't a kind of effect.`);
}

// A Recolour (R10a): for each colour and brightness the ticked zones have (zones with the same are
// one), a tint towards the colour: it fades in over `in`, holds, and fades out over `out`, so the
// normal look keeps moving under it and its kicks (which lift the level) pulse in the new colour.
// Brightness up to 100 % is the colour itself made darker (70 %: 70 % of the light, no layer of its
// own); over 100 % a lift on top (200 %: full). Fades in and out are layers of their own (the demo
// has no room for a fade that holds: firmware R10c).
function recolourLayers(look, ctx, len) {
  const { z, slotOf } = ctx;
  const rin = steps(Math.max(0, look.in || 0)), rout = steps(Math.max(0, look.out || 0));
  if (rin + rout > len - STEP + 1e-9) throw new Error(`Recolour: its fade in (${rin} beats) and fade out (${rout}) must together be shorter than it is (${len} beats).`);
  const hold = steps(len - rin - rout);
  const paints = [];
  for (const p of PARTS) {
    const x = look.paint && look.paint[p];
    if (!look.zones.includes(p) || !x) continue;
    const pct = Math.max(0, Math.min(200, Number(x.level) || 0));
    const key = JSON.stringify([x.colour, pct]), same = paints.find((q) => q.key === key);
    if (same) same.parts.push(p); else paints.push({ key, parts: [p], colour: x.colour, pct });
  }
  const out = [];
  const env = (leds, colour, top, blend) => {   // in, hold, out, as fades
    if (rin) out.push({ move: 'fade', leds, at: 0, for: rin, colour: [colour, colour], level: [0, top], curve: 'linear', blend });
    out.push({ move: 'fade', leds, at: rin, for: hold, colour: [colour, colour], level: [top, top], blend });
    if (rout) out.push({ move: 'fade', leds, at: rin + hold, for: rout, colour: [colour, colour], level: [top, 0], curve: 'linear', blend });
  };
  for (const q of paints) {
    const leds = ledsOf(z, q.parts), k = Math.min(100, q.pct) / 100;
    env(leds, slotOf(q.colour.map((v) => Math.round(v * k)), true), 255, 'tint');
    if (q.pct > 100) env(leds, 0, pctLevel(q.pct - 100), 'lift');
  }
  return out;
}

// ---------------------------------------------------------------- tracks to a recipe
export const emptyTracks = () => ({ under: { mode: 'normal', colour: [255, 255, 255], level: 30 }, rows: [] });
const live = (t) => t.rows.filter((r) => !r.muted);

// When the animation ends: the end of the last copy of anything that isn't muted, or `length` if
// that's later. Whole beats.
export function tracksLength(tracks, length = 0) {
  let end = 0;
  for (const r of live(tracks)) for (const g of r.groups) for (const a of g.at) end = Math.max(end, steps(a) + Math.max(STEP, steps(g.look.for)));
  return Math.max(1, Math.ceil(Math.max(end, length) - 1e-9));
}

// The recipe: the rows from the bottom up (the top row draws last, over the rest), each linked set
// of copies its layers with "again" at the other copies' times. Over the normal look (the default)
// the drive keeps drawing it under them ("over"); under a colour, a glow of it comes first.
// drive: makeDrive(profile) for the zones. The tracks themselves go in the recipe ("tracks"), so a
// saved animation opens again as tracks.
export function tracksRecipe({ name = 'Light cues', tracks, drive, notes }) {
  const under = tracks.under || { mode: 'normal' };
  const mode = underMode(under), over = isOver(under);
  const custom = [];
  const slotOf = (rgb, keepBlack = false) => {
    const c = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    if (!keepBlack && c.every((v) => v === 0)) return 0;
    let i = custom.findIndex((x) => x.every((v, k) => v === c[k]));
    if (i < 0) {
      if (custom.length >= 10) throw new Error('The effects use more than 10 different colours; one animation can have 10. Use the same colour for some of them.');
      i = custom.push(c) - 1;
    }
    return 6 + i;
  };
  const total = tracksLength(tracks);
  const underLevel = mode === 'colour' ? pctLevel(under.level) : 0, u = underLevel ? slotOf(under.colour) : 0;
  const layers = mode === 'colour' ? [{ move: 'glow', leds: 'all', for: total, colour: u, level: underLevel }] : [];
  const ctx = { z: zones(drive), slotOf, over, u, uL: underLevel };
  let placed = 0;
  for (const r of [...live(tracks)].reverse()) {
    for (const g of r.groups) {
      const times = [...new Set(g.at.map(steps))].sort((a, b) => a - b);
      if (!times.length) continue;
      placed += times.length;
      for (const l of effectLayers(r.kind, g.look, ctx)) {
        const lay = { ...l, at: steps(times[0] + l.at) };
        if (times.length > 1) lay.again = times.slice(1).map((t) => steps(t + l.at));
        layers.push(lay);
      }
    }
  }
  if (!placed) throw new Error('Nothing to play yet: place an effect on a layer (or unmute one).');
  // (more than 15 layers is allowed here: buildTracks squeezes them, then says if it's still too many)
  const recipe = { type: 'animation', name, board: 'pulse', timing: 'beats', once: true };
  if (over) recipe.over = true;
  const onWhat = { normal: 'the normal look', dark: 'dark', colour: 'a colour' }[mode], n = live(tracks).length;
  recipe.notes = notes || `${placed} effect${placed === 1 ? '' : 's'} on ${n} layer${n === 1 ? '' : 's'} over ${onWhat}, ${total} beats, made in Light cues.`;
  if (custom.length) recipe.custom = custom;
  recipe.layers = layers;
  recipe.tracks = clone(tracks);
  return recipe;
}

// How many layers of animation each row's effects make, before squeezing (rows[i].id -> count):
// a Recolour is up to 3 for each colour (fade in, hold, fade out), a white pulse that comes in 2...
// Linked copies are in the same layers. Muted rows make none.
export function rowLayers(tracks, drive) {
  const ctx = { z: zones(drive), slotOf: () => 6, over: isOver(tracks.under), u: 0, uL: 0 };
  const out = {};
  for (const r of tracks.rows) {
    let n = 0;
    if (!r.muted) for (const g of r.groups) { try { if (g.at.length) n += effectLayers(r.kind, g.look, ctx).length; } catch {} }
    out[r.id] = n;
  }
  return out;
}

// The recipe checked, squeezed for the drive (js/squeeze.js: the same light in every frame, in
// fewer layers and bytes) and packed: { recipe, anim (normalised), bytes, layers (how many),
// before: { layers, bytes } (as built, before squeezing), tooMany (more layers than a drive takes:
// anim still plays on screen, but the recipe can't go to a drive) }. squeeze: false (while keys
// are held) skips it: the same frames, sooner.
export function buildTracks({ squeeze: sq = true, ...opts }) {
  const raw = tracksRecipe(opts);
  const s = sq ? squeeze(raw, { drive: opts.drive }) : null;
  const recipe = s ? s.recipe : raw;
  const anim = s ? s.anim : normalise(raw, { most: Infinity });
  const bytes = s ? s.bytes : pack(raw, { most: Infinity }).length;
  const before = s ? s.before : { layers: anim.layers.length, bytes };
  return { recipe, anim, bytes, layers: anim.layers.length, before, tooMany: anim.layers.length > MAX_LAYERS, failed: !!(s && s.failed) };
}
// Why it can't go to a drive yet, in words (null: it can).
export function tooManyText(built) {
  if (!built || !built.tooMany) return null;
  const squeezed = built.before.layers > built.layers ? `, even squeezed (from ${built.before.layers})` : '';
  return `Too many for a drive: it plays ${MAX_LAYERS} layers of animation at most, and these are ${built.layers}${squeezed}. Mute or delete some (each layer's tag says how many it makes), or make copies of one effect linked (Alt-drag, or Add copies): a linked copy is about a byte, a separate one a whole layer.`;
}

// R8, R9's cues: as tracks, then the recipe.
export const cuesRecipe = ({ cues, under, ...rest }) => tracksRecipe({ ...rest, tracks: cuesToTracks(cues, under) });
export const build = ({ cues, under, ...rest }) => buildTracks({ ...rest, tracks: cuesToTracks(cues, under) });

// ---------------------------------------------------------------- editing (the screen calls these)
// A placed copy is { row, group, i }: rows[row].groups[group].at[i].
let nextId = 1;
const newId = () => `l${Date.now().toString(36)}${(nextId++).toString(36)}`;
export function newRow(tracks, kind, name) {
  const same = tracks.rows.filter((r) => r.kind === kind).length;
  return { id: newId(), name: name || `${KINDS[kind].name}${same ? ` ${same + 1}` : ''}`, kind, muted: false, groups: [] };
}
// Every placed copy: { row, group, i, at, for, linked (how many copies it has) } in row order.
export function clips(tracks) {
  const out = [];
  tracks.rows.forEach((r, ri) => r.groups.forEach((g, gi) => g.at.forEach((at, i) => out.push({ row: ri, group: gi, i, at, for: g.look.for, linked: g.at.length }))));
  return out;
}
// Put an effect on a row at `at`: it joins the row's copies that look the same (linked), else a new set.
export function place(tracks, ri, at, look) {
  const r = tracks.rows[ri], t = Math.max(0, steps(at));
  const g = r.groups.find((x) => sameLook(x.look, look));
  if (g) {
    if (!g.at.some((a) => Math.abs(a - t) < 1e-9)) g.at.push(t);
    g.at.sort((a, b) => a - b);
    return { row: ri, group: r.groups.indexOf(g), i: g.at.indexOf(t) };
  }
  r.groups.push({ at: [t], look: clone(look) });
  return { row: ri, group: r.groups.length - 1, i: 0 };
}
export function moveClip(tracks, c, at) {
  const g = tracks.rows[c.row].groups[c.group], t = Math.max(0, steps(at));
  g.at.splice(c.i, 1);
  if (!g.at.some((a) => Math.abs(a - t) < 1e-9)) g.at.push(t);
  g.at.sort((a, b) => a - b);
  return { row: c.row, group: c.group, i: g.at.indexOf(t) };
}
// A copy along the row at `at`, linked to it (the same look)
export function copyClip(tracks, c, at) {
  const g = tracks.rows[c.row].groups[c.group], t = Math.max(0, steps(at));
  if (!g.at.some((a) => Math.abs(a - t) < 1e-9)) g.at.push(t);
  g.at.sort((a, b) => a - b);
  return { row: c.row, group: c.group, i: g.at.indexOf(t) };
}
// "Make this one separate": the copy gets its own look (the same to start with)
export function separate(tracks, c) {
  const r = tracks.rows[c.row], g = r.groups[c.group];
  if (g.at.length < 2) return c;
  const [t] = g.at.splice(c.i, 1);
  r.groups.push({ at: [t], look: clone(g.look) });
  return { row: c.row, group: r.groups.length - 1, i: 0 };
}
export function deleteClip(tracks, c) {
  const r = tracks.rows[c.row], g = r.groups[c.group];
  g.at.splice(c.i, 1);
  if (!g.at.length) r.groups.splice(c.group, 1);
}
// Change the look of a copy, and so of every copy linked to it. Returns where the copy is now.
// (Two sets on a row that come to look the same stay apart until one is placed again: unlinking
// is the user's to choose.)
export function setLook(tracks, c, change) {
  Object.assign(tracks.rows[c.row].groups[c.group].look, clone(change));
  return c;
}
// Move a row up (-1) or down (+1): rows higher up draw over lower ones.
export function moveRow(tracks, ri, by) {
  const to = ri + by;
  if (to < 0 || to >= tracks.rows.length) return ri;
  const [r] = tracks.rows.splice(ri, 1);
  tracks.rows.splice(to, 0, r);
  return to;
}

// ---------------------------------------------------------------- older cues and what's kept
// R8, R9's list of cues as tracks: a row for each kind (cuts on top, as they went dark over
// everything), cues with the same look on a row linked. "Normal look in new colours" is a Recolour
// at the bottom over the cues' length: the top and middle (red in the look) get the new red, the
// bottom the new orange (or red).
export function cuesToTracks(cues, under) {
  const mode = underMode(under), u = cleanUnder(under);
  const t = { under: { mode, colour: u.colour, level: u.level }, rows: [] };
  const kinds = [...new Set(cues.map((c) => c.kind))].sort((a, b) => (b === 'cut') - (a === 'cut'));
  for (const kind of kinds) {
    t.rows.push(newRow(t, kind));
    for (const c of cues.filter((x) => x.kind === kind).sort((a, b) => a.at - b.at)) {
      place(t, t.rows.length - 1, c.at, defaultLook(kind, { zones: c.zone === 'all' ? PARTS : [c.zone], colour: c.colour, level: c.level, for: c.for }));
    }
  }
  if (under && under.mode === 'recolour' && (u.colours[1] || u.colours[2])) {
    const red = u.colours[1], orange = u.colours[2] || u.colours[1], paint = defaultLook('recolour').paint;
    if (red) { paint.top = { colour: red, level: 100 }; paint.middle = { colour: red, level: 100 }; }
    if (orange) paint.bottom = { colour: orange, level: 100 };
    const look = { ...defaultLook('recolour'), for: cuesLength(cues), zones: PARTS.filter((p) => (p === 'bottom' ? orange : red)), paint, in: 0, out: 0 };
    t.rows.push(newRow(t, 'recolour'));
    place(t, t.rows.length - 1, 0, look);
  }
  return t;
}
// When R8/R9 cues end: the end of the last cue, or `length` if that's later. Whole beats.
export function cuesLength(cues, length = 0) {
  const end = cues.reduce((m, c) => Math.max(m, steps(c.at) + Math.max(STEP, steps(c.for))), 0);
  return Math.max(1, Math.ceil(Math.max(end, length) - 1e-9));
}

const rgbOk = (c) => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite);
// Tracks kept in the browser or in a saved animation, checked before they're used (null: none).
export function cleanTracks(x) {
  if (!x || typeof x !== 'object' || !Array.isArray(x.rows)) return null;
  const u = cleanUnder(x.under);
  const out = { under: { mode: u.mode, colour: u.colour, level: u.level }, rows: [] };
  for (const r of x.rows) {
    if (!r || !KINDS[r.kind] || !Array.isArray(r.groups)) continue;
    const row = { id: typeof r.id === 'string' ? r.id : newId(), name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 60) : KINDS[r.kind].name, kind: r.kind, muted: !!r.muted, groups: [] };
    for (const g of r.groups) {
      if (!g || !Array.isArray(g.at) || !g.look || typeof g.look !== 'object') continue;
      const at = g.at.filter((a) => Number.isFinite(a) && a >= 0).map(steps);
      const l = g.look, d = defaultLook(r.kind);
      const look = {
        for: Number.isFinite(l.for) && l.for > 0 ? l.for : d.for,
        zones: Array.isArray(l.zones) ? PARTS.filter((p) => l.zones.includes(p)) : d.zones,
        colour: rgbOk(l.colour) ? l.colour.map(Number) : d.colour,
        level: Number.isFinite(l.level) ? l.level : d.level,
        in: Number.isFinite(l.in) && l.in >= 0 ? l.in : d.in,
        curve: CURVE_NAMES[l.curve] ? l.curve : d.curve,
        sweep: SWEEPS[l.sweep] ? l.sweep : 'none',
        spread: Number.isFinite(l.spread) && l.spread > 0 ? l.spread : d.spread,
      };
      if (KINDS[r.kind].recolour) {
        look.paint = {};
        for (const p of PARTS) {
          const y = l.paint && l.paint[p];
          look.paint[p] = y && rgbOk(y.colour) ? { colour: y.colour.map(Number), level: Number.isFinite(y.level) ? y.level : 100 } : d.paint[p];
        }
        look.out = Number.isFinite(l.out) && l.out >= 0 ? l.out : d.out;
      }
      if (at.length) row.groups.push({ at: [...new Set(at)].sort((a, b) => a - b), look });
    }
    out.rows.push(row);
  }
  return out;
}

// Where something is, in words: "bar 2, beat 3½".
export function beatsText(b) {
  const whole = Math.floor(b + 1e-9), f = b - whole;
  const frac = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round(f * 4) / 4 === f ? f : -1];
  if (frac !== undefined) return `${whole || (frac ? '' : '0')}${frac}`;
  return String(Math.round(b * 16) / 16);
}
export function whereText(at) {
  const bar = Math.floor(at / 4) + 1, beat = at - (bar - 1) * 4 + 1;
  return `bar ${bar}, beat ${beatsText(beat)}`;
}

// Taps that line up with the kicks or snares the drive hears, 4 or more in a row, and could be
// one effect: "Turn these 12 white pulses into: white pulse on every snare, bar 3 to bar 6".
// hits: { kick: [beats], snare: [beats] } from the start, as the drive heard the song (js/cues-tab.js
// runs it through the simulated mic). Each tap must be within `near` beats of a hit, with no hit
// of that kind skipped between them. cues: [{ kind, at, for, zone, colour, level }] (zone: any text
// saying which LEDs; zones: the ticked ones). Returns [{ indexes (into cues), cue (the one cue),
// text }], the longest first, no tap in two.
export const FOLDS = { white: 'Flash', bright: 'Bright' };
export function foldOffers(cues, hits, { near = 0.2, min = 4 } = {}) {
  const found = [];
  const groups = new Map();
  cues.forEach((c, i) => {
    if (!FOLDS[c.kind]) return;
    const key = [c.kind, c.zone, c.level, ...(KINDS[c.kind].colour ? c.colour : [])].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const idx of groups.values()) {
    idx.sort((a, b) => cues[a].at - cues[b].at);
    for (const type of ['kick', 'snare']) {
      const H = [...(hits[type] || [])].sort((a, b) => a - b);
      const hitOf = (c) => { let best = -1; H.forEach((h, j) => { if (Math.abs(h - c.at) <= near && (best < 0 || Math.abs(h - c.at) < Math.abs(H[best] - c.at))) best = j; }); return best; };
      let run = [];
      const close = () => { if (run.length >= min) found.push({ type, run, H }); run = []; };
      for (const i of idx) {
        const j = hitOf(cues[i]);
        if (j < 0) { close(); continue; }
        if (run.length && j !== run[run.length - 1].j + 1) close();
        run.push({ i, j });
      }
      close();
    }
  }
  found.sort((a, b) => b.run.length - a.run.length);
  const used = new Set(), out = [];
  for (const { type, run, H } of found) {
    if (run.some((r) => used.has(r.i))) continue;
    run.forEach((r) => used.add(r.i));
    const first = cues[run[0].i], last = cues[run[run.length - 1].i];
    const at = Math.max(0, Math.floor(Math.min(first.at, H[run[0].j]) / STEP) * STEP);
    const end = Math.max(last.at + last.for, H[run[run.length - 1].j] + 0.5);
    const kind = `${type}${FOLDS[first.kind]}`;
    const cue = { kind, at, for: Math.max(0.25, Math.ceil((end - at) * 4 - 1e-9) / 4), zone: first.zone, colour: [...first.colour], level: first.level };
    const what = KINDS[first.kind].name.toLowerCase();
    const zoneName = ZONE_NAMES[first.zone] ? (first.zone === 'all' ? '' : ZONE_NAMES[first.zone].toLowerCase())
      : first.zones && first.zones.length < 3 ? first.zones.join(' and ') : '';
    out.push({
      indexes: run.map((r) => r.i), cue,
      text: `Turn these ${run.length} ${what}s into: ${what} on every ${type}${zoneName ? ` (${zoneName} LEDs)` : ''}, bar ${Math.floor(at / 4) + 1} to bar ${Math.max(Math.floor(at / 4) + 1, Math.ceil((at + cue.for) / 4 - 1e-9))}`,
    });
  }
  return out;
}
// The cues with an offer taken: its taps out, its one cue in.
export const fold = (cues, offer) => [...cues.filter((_, i) => !offer.indexes.includes(i)), offer.cue];

// The same on tracks: the white and brightness pulses placed (muted rows left out) as cues for
// foldOffers, each with where it is ({ row, group, i }).
export function tracksCues(tracks) {
  const out = [];
  tracks.rows.forEach((r, ri) => {
    if (r.muted || !FOLDS[r.kind]) return;
    r.groups.forEach((g, gi) => g.at.forEach((at, i) => out.push({
      kind: r.kind, at, for: g.look.for, zone: g.look.zones.length === 3 ? 'all' : g.look.zones.join('+'), zones: g.look.zones,
      colour: g.look.colour, level: g.look.level, where: { row: ri, group: gi, i },
    })));
  });
  return out;
}
// An offer taken on tracks: its taps deleted, a new row on top with the one effect; rows left
// empty by it go.
export function foldTracks(tracks, list, offer) {
  const first = list[offer.indexes[0]];
  const taken = offer.indexes.map((k) => list[k].where).sort((a, b) => b.row - a.row || b.group - a.group || b.i - a.i);
  const rows = new Set(taken.map((w) => tracks.rows[w.row]));
  for (const w of taken) deleteClip(tracks, w);
  tracks.rows = tracks.rows.filter((r) => !(rows.has(r) && !r.groups.length));
  tracks.rows.unshift(newRow(tracks, offer.cue.kind));
  place(tracks, 0, offer.cue.at, defaultLook(offer.cue.kind, { zones: first.zones, colour: offer.cue.colour, level: offer.cue.level, for: offer.cue.for }));
  return tracks;
}

// Cues saved between visits (R8, R9: the page's own storage) are checked before they're used.
export function cleanCues(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && KINDS[c.kind] && Number.isFinite(c.at) && c.at >= 0 && Number.isFinite(c.for) && c.for > 0
    && ZONES.includes(c.zone) && Array.isArray(c.colour) && c.colour.length === 3 && Number.isFinite(c.level))
    .slice(0, MAX_CUES)
    .map((c) => ({ kind: c.kind, at: c.at, for: c.for, zone: c.zone, colour: c.colour.map(Number), level: Number(c.level) }));
}

export const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
export const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);

// What's under the cues, saved between visits, checked (R9's "recolour" mode keeps its colours for
// cuesToTracks).
export function cleanUnder(u) {
  const rgb = (c) => (rgbOk(c) ? c.map(Number) : null);
  if (!u || typeof u !== 'object') return { mode: 'normal', colour: [255, 255, 255], level: 30, colours: {} };
  const out = { mode: underMode(u), colour: rgb(u.colour) || [255, 255, 255], level: Number.isFinite(u.level) ? u.level : 30, colours: {} };
  for (const k of Object.keys(LOOK_COLOURS)) { const c = rgb(u.colours && u.colours[k]); if (c) out.colours[k] = c; }
  return out;
}
