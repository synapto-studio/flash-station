// Light cues (R8): play a song, press keys where the lights should do something (a white pulse,
// a shimmer, a cut to dark, a fade...), then play it back. Each cue becomes one layer of a
// beat-timed one-shot recipe (js/player.js), so a song moment can play it on a Pulse. The screen
// is js/cues-tab.js; this file turns cues into a recipe and back.
//
//   cue: { kind: 'white', at: 4.5, for: 0.5, zone: 'all', colour: [255, 255, 255], level: 100 }
//   at and for in beats from the start of the animation (steps of 1/16), level in %.

import { normalise, pack } from './player.js';

// One layer each, and one for what's under the cues: a recipe has at most 15.
export const MAX_CUES = 14;
export const STEP = 1 / 16;          // the recipe's finest time: 1/16 of a beat
// Room on the 2.1 demo engine for each of 3 more song moments' animations next to Poison's (firmware
// build of 29 Oct 2026: 788 bytes of the show free, less 3 x (a moment's print, 96, and its delay
// and flags, 7), shared by 3). The demo takes 4 moments.
export const DEMO_ROOM = 159;

// key: what to press. colour: whether the cue has a colour of its own. tap: its length in beats
// when the key is only tapped (held longer, it lasts as long as the key is held).
export const KINDS = {
  white:   { key: 'W', name: 'White pulse',      colour: true,  white: true, tap: 0.5, says: 'a flash that fades back to what\'s under the cues' },
  bright:  { key: 'B', name: 'Brightness pulse', colour: false, tap: 0.5, says: 'lifts whatever is lit towards full, then fades back' },
  shimmer: { key: 'S', name: 'Shimmer',          colour: true,  white: true, tap: 1, says: 'fast flickers on every 1/32 note, rippling up the drive' },
  stutter: { key: 'T', name: 'Stutter',          colour: true,  tap: 1, says: 'chops on and off on every 16th note' },
  cut:     { key: 'X', name: 'Cut out',          colour: false, tap: 0.5, says: 'all the chosen LEDs dark' },
  fadeUp:  { key: 'F', name: 'Fade up',          colour: true,  tap: 1, says: 'from dark up to the colour' },
  fadeDown:{ key: 'D', name: 'Fade down',        colour: true,  tap: 1, says: 'from the colour down to what\'s under the cues' },
};
export const KIND_BY_KEY = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v.key, k]));
export const ZONES = ['all', 'top', 'middle', 'bottom'];
export const ZONE_NAMES = { all: 'All', top: 'Top', middle: 'Middle', bottom: 'Bottom' };

export const snapTo = (beats, step) => Math.round(beats / step) * step;
const steps = (beats) => Math.round(beats / STEP) * STEP; // what the recipe can hold
const pctLevel = (pct) => Math.max(0, Math.min(255, Math.round(Number(pct) * 2.55)));

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

// What a cue's layer looks like, with its colour as a slot (0 off, 6+ the recipe's own). Pulses
// and fades start or end at what's under the cues (u: its slot, uL: its level), so nothing jumps.
function layerFor(cue, leds, slot, u, uL) {
  const at = steps(cue.at), len = Math.max(STEP, steps(cue.for)), L = pctLevel(cue.level);
  const base = { leds, at, for: len };
  switch (cue.kind) {
    case 'white':    return { move: 'fade', ...base, colour: [slot, u], level: [L, uL], curve: 'out' };
    case 'bright':   return { move: 'fade', ...base, level: [L, 0], curve: 'out', blend: 'lift' };
    case 'shimmer':  return { move: 'pulse', ...base, colour: slot, low: Math.round(L * 0.15), high: L, every: 0.125, rise: 0, fall: 0.125, down: 'linear', lag: 0.0625 };
    case 'stutter':  return { move: 'pulse', ...base, colour: slot, low: 0, high: L, every: 0.25, rise: 0, fall: 0.125, down: 'in' };
    case 'cut':      return { move: 'glow', ...base, colour: 0, level: 0 };
    case 'fadeUp':   return { move: 'fade', ...base, colour: [u, slot], level: [uL, L] };
    case 'fadeDown': return { move: 'fade', ...base, colour: [slot, u], level: [L, uL] };
    default: throw new Error(`"${cue.kind}" isn't a kind of cue.`);
  }
}

// When the animation ends: the end of the last cue, or `length` if that's later. Whole beats.
export function cuesLength(cues, length = 0) {
  const end = cues.reduce((m, c) => Math.max(m, steps(c.at) + Math.max(STEP, steps(c.for))), 0);
  return Math.max(1, Math.ceil(Math.max(end, length) - 1e-9));
}

// The recipe: what's under the cues (a glow for the whole length; level 0 is dark), then the
// cues in time order, cuts last so they go dark over everything else.
// under: { colour: [r, g, b], level: % }. drive: makeDrive(profile) for the zones.
export function cuesRecipe({ name = 'Light cues', cues, under = { colour: [0, 0, 0], level: 0 }, length = 0, drive, notes }) {
  if (cues.length > MAX_CUES) throw new Error(`That's ${cues.length} cues; one animation can have ${MAX_CUES}. Delete some, or save these and start another.`);
  const z = zones(drive);
  const custom = [];
  const slotOf = (rgb) => {
    const c = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    if (c.every((v) => v === 0)) return 0;
    let i = custom.findIndex((x) => x.every((v, k) => v === c[k]));
    if (i < 0) {
      if (custom.length >= 10) throw new Error('The cues use more than 10 different colours; one animation can have 10. Use the same colour for some of them.');
      i = custom.push(c) - 1;
    }
    return 6 + i;
  };
  const total = cuesLength(cues, length);
  const underLevel = pctLevel(under.level), u = underLevel ? slotOf(under.colour) : 0;
  const layers = [{ move: 'glow', leds: 'all', for: total, colour: u, level: underLevel }];
  const order = [...cues].sort((a, b) => (a.kind === 'cut') - (b.kind === 'cut') || a.at - b.at);
  for (const c of order) {
    const leds = z[c.zone] && z[c.zone].length ? (c.zone === 'all' ? 'all' : z[c.zone]) : 'all';
    layers.push(layerFor(c, leds, KINDS[c.kind].colour ? slotOf(c.colour) : 0, u, underLevel));
  }
  const recipe = { type: 'animation', name, board: 'pulse', timing: 'beats', once: true };
  recipe.notes = notes || `${cues.length} light cue${cues.length === 1 ? '' : 's'} over ${total} beats, made with the cue keys.`;
  if (custom.length) recipe.custom = custom;
  recipe.layers = layers;
  return recipe;
}

// The recipe checked and packed: { recipe, anim (normalised), bytes }.
export function build(opts) {
  const recipe = cuesRecipe(opts);
  const anim = normalise(recipe);
  return { recipe, anim, bytes: pack(recipe).length };
}

// A cue as a line for the list: "Bar 2, beat 3½ · White pulse · ½ beat".
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

// Cues saved between visits (the page's own storage) are checked before they're used.
export function cleanCues(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && KINDS[c.kind] && Number.isFinite(c.at) && c.at >= 0 && Number.isFinite(c.for) && c.for > 0
    && ZONES.includes(c.zone) && Array.isArray(c.colour) && c.colour.length === 3 && Number.isFinite(c.level))
    .slice(0, MAX_CUES)
    .map((c) => ({ kind: c.kind, at: c.at, for: c.for, zone: c.zone, colour: c.colour.map(Number), level: Number(c.level) }));
}

export const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
export const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16) || 0);
