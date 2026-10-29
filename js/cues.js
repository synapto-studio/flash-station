// Light cues (R8, R9): play a song, press keys where the lights should do something (a white
// pulse, a shimmer, a cut to dark, a fade, a flash on every snare...), then play it back. Each cue
// becomes one layer of a beat-timed one-shot recipe (js/player.js), so a song moment can play it
// on a Pulse, over the drive's normal look (R9) or over dark or a colour. The screen is
// js/cues-tab.js; this file turns cues into a recipe and back.
//
//   cue: { kind: 'white', at: 4.5, for: 0.5, zone: 'all', colour: [255, 255, 255], level: 100 }
//   at and for in beats from the start of the animation (steps of 1/16), level in %.
//   under: { mode: 'normal' | 'recolour' | 'dark' | 'colour', colour, level (for 'colour'),
//            colours: { 1: [r, g, b], 2: ... } (for 'recolour': the normal look's red, orange...) }

import { normalise, pack } from './player.js';

// One layer each (a recipe has at most 15), and under a colour one more for the colour.
export const MAX_CUES = 15;
export const UNDER = { normal: 'Normal look', recolour: 'Normal look in new colours', dark: 'Dark', colour: 'A colour' };
// What's under the cues; cues saved before R9 have { colour, level } (dark at level 0).
export const underMode = (u) => (!u ? 'normal' : UNDER[u.mode] ? u.mode : u.level > 0 ? 'colour' : 'dark');
export const isOver = (u) => ['normal', 'recolour'].includes(underMode(u));
export const maxCues = (u) => (underMode(u) === 'colour' ? MAX_CUES - 1 : MAX_CUES);
// The colour set's colours the normal look (js/animations.js pulseAmbient) uses: red and orange.
export const LOOK_COLOURS = { 1: 'Red', 2: 'Orange' };
const HIT_LOUD = 60; // dB: kick and snare cues flash whenever the drive hears them (it recognised the song)
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
  // R9: one layer however many hits; they follow what the drive hears, not the beat grid
  kickBright:  { key: 'K', name: 'Brightness pulse on every kick',  colour: false, hits: 'kick',  tap: 4, says: 'lifts whatever is lit on each kick the drive hears, for as long as the cue lasts' },
  kickFlash:   { key: null, name: 'Colour flash on every kick',     colour: true,  hits: 'kick',  tap: 4, says: 'flashes the colour on each kick the drive hears, for as long as the cue lasts' },
  snareBright: { key: 'N', name: 'Brightness pulse on every snare', colour: false, hits: 'snare', tap: 4, says: 'lifts whatever is lit on each snare the drive hears, for as long as the cue lasts' },
  snareFlash:  { key: null, name: 'Colour flash on every snare',    colour: true,  white: true, hits: 'snare', tap: 4, says: 'flashes the colour on each snare the drive hears, for as long as the cue lasts' },
};
export const KIND_BY_KEY = Object.fromEntries(Object.entries(KINDS).filter(([, v]) => v.key).map(([k, v]) => [v.key, k]));
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
// and fades start or end at what's under the cues (u: its slot, uL: its level), so nothing jumps;
// over the normal look they flash over it and fade back into it (fade's flash blend).
function layerFor(cue, leds, slot, u, uL, over) {
  const at = steps(cue.at), len = Math.max(STEP, steps(cue.for)), L = pctLevel(cue.level);
  const base = { leds, at, for: len };
  const k = KINDS[cue.kind];
  if (k && k.hits) return { move: k.hits, ...base, loud: HIT_LOUD, colour: k.colour ? slot : 0 };
  if (over) {
    if (cue.kind === 'white' || cue.kind === 'fadeDown') return { move: 'fade', ...base, colour: [slot, slot], level: [L, 0], curve: cue.kind === 'white' ? 'out' : 'ease', blend: 'flash' };
    if (cue.kind === 'fadeUp') return { move: 'fade', ...base, colour: [slot, slot], level: [0, L], blend: 'flash' };
  }
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

// The recipe: the cues in time order, cuts last so they go dark over everything else. Over the
// normal look (the default) the drive keeps drawing it under them ("over"), in new colours if
// asked ("recolour"); under a colour, a glow of it comes first, for the whole length.
// under: see the top. drive: makeDrive(profile) for the zones.
export function cuesRecipe({ name = 'Light cues', cues, under = { mode: 'normal' }, length = 0, drive, notes }) {
  const mode = underMode(under), over = isOver(under), most = maxCues(under);
  if (cues.length > most) throw new Error(`That's ${cues.length} cues; one animation can have ${most}${mode === 'colour' ? ' over a colour' : ''}. Delete some, or save these and start another.`);
  const z = zones(drive);
  const custom = [];
  const slotOf = (rgb, keepBlack = false) => {
    const c = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    if (!keepBlack && c.every((v) => v === 0)) return 0;
    let i = custom.findIndex((x) => x.every((v, k) => v === c[k]));
    if (i < 0) {
      if (custom.length >= 10) throw new Error('The cues use more than 10 different colours; one animation can have 10. Use the same colour for some of them.');
      i = custom.push(c) - 1;
    }
    return 6 + i;
  };
  const total = cuesLength(cues, length);
  const recolour = {};
  if (mode === 'recolour') for (const k of Object.keys(LOOK_COLOURS)) if (under.colours && Array.isArray(under.colours[k])) recolour[k] = slotOf(under.colours[k], true);
  const underLevel = mode === 'colour' ? pctLevel(under.level) : 0, u = underLevel ? slotOf(under.colour) : 0;
  const layers = mode === 'colour' ? [{ move: 'glow', leds: 'all', for: total, colour: u, level: underLevel }] : [];
  const order = [...cues].sort((a, b) => (a.kind === 'cut') - (b.kind === 'cut') || a.at - b.at);
  for (const c of order) {
    const leds = z[c.zone] && z[c.zone].length ? (c.zone === 'all' ? 'all' : z[c.zone]) : 'all';
    layers.push(layerFor(c, leds, KINDS[c.kind].colour ? slotOf(c.colour) : 0, u, underLevel, over));
  }
  const recipe = { type: 'animation', name, board: 'pulse', timing: 'beats', once: true };
  if (over) recipe.over = true;
  if (Object.keys(recolour).length) recipe.recolour = recolour;
  const onWhat = { normal: 'the normal look', recolour: 'the normal look in new colours', dark: 'dark', colour: 'a colour' }[mode];
  recipe.notes = notes || `${cues.length} light cue${cues.length === 1 ? '' : 's'} over ${onWhat}, ${total} beats, made with the cue keys.`;
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

// Taps that line up with the kicks or snares the drive hears, 4 or more in a row, and could be
// one cue: "Turn these 12 white pulses into: white pulse on every snare, bar 3 to bar 6".
// hits: { kick: [beats], snare: [beats] } from the start, as the drive heard the song (js/cues-tab.js
// runs it through the simulated mic). Each tap must be within `near` beats of a hit, with no hit
// of that kind skipped between them. Returns [{ indexes (into cues), cue (the one cue), text }],
// the longest first, no tap in two.
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
    const zone = first.zone === 'all' ? '' : ` (${ZONE_NAMES[first.zone].toLowerCase()} LEDs)`;
    out.push({
      indexes: run.map((r) => r.i), cue,
      text: `Turn these ${run.length} ${what}s into: ${what} on every ${type}${zone}, bar ${Math.floor(at / 4) + 1} to bar ${Math.max(Math.floor(at / 4) + 1, Math.ceil((at + cue.for) / 4 - 1e-9))}`,
    });
  }
  return out;
}
// The cues with an offer taken: its taps out, its one cue in.
export const fold = (cues, offer) => [...cues.filter((_, i) => !offer.indexes.includes(i)), offer.cue];

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

// What's under the cues, saved between visits, checked.
export function cleanUnder(u) {
  const rgb = (c) => (Array.isArray(c) && c.length === 3 && c.every(Number.isFinite) ? c.map(Number) : null);
  if (!u || typeof u !== 'object') return { mode: 'normal' };
  const out = { mode: underMode(u), colour: rgb(u.colour) || [255, 255, 255], level: Number.isFinite(u.level) ? u.level : 30, colours: {} };
  for (const k of Object.keys(LOOK_COLOURS)) { const c = rgb(u.colours && u.colours[k]); if (c) out.colours[k] = c; }
  return out;
}
