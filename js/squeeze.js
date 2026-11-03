// Squeezing an animation for the drive (Light cues, 3 Nov 2026): the same light on every LED in
// every frame, in fewer layers and bytes, using only what a drive already reads (no new firmware):
//  1. Layers that are the same apart from when they play become one layer that plays again
//     ("again", R10c: about a byte a time instead of a whole layer), wherever no layer drawn
//     between them lights the same LED at the same time (so nothing changes what's on top).
//  2. The layers go in the order that takes the fewest bytes: a layer with the same LEDs as the one
//     before has no LED byte, one that starts with it (or when it ends) no start time. Two layers
//     that light the same LED at the same time keep their order (the one on top stays on top).
// Then the check: both are drawn every 1/32 beat (or 5 ms) of the animation, over a made-up normal
// look with kicks and snares, and must match on every LED of every frame; if not, the animation
// comes back as it was.
//
//   squeeze(recipe, { drive }) -> { recipe, anim, layers, bytes, before: { layers, bytes }, squeezed }

import { normalise, pack, levels, length, palette, MAX_AGAIN, MAX_LAYERS } from './player.js';

const ANY = { most: Infinity };   // before squeezing it may have more layers than a drive takes
const STEP = { ms: 10, beats: 1 / 16 };
const FINE = { ms: 1, beats: 16384 };   // the player's time units (js/player.js prepare)
const BEAM = 24;                        // orders kept while looking for the shortest
const maskOf = (leds) => leds.reduce((m, n) => m | (1 << (n - 1)), 0);
const near = (a, b) => Math.abs(a - b) < 1e-6;

// The animation's layers as items: when each plays (its start, then its "again" times), for how
// long, its LEDs, and everything else (two layers with the same "rest" are the same layer).
function itemsOf(anim) {
  return anim.layers.map((l, i) => {
    const { at, again, ...rest } = l;
    const dur = Number.isFinite(l.for) ? l.for : null;   // (no length: it can't play again)
    return { members: [i], key: dur === null ? null : JSON.stringify(rest), rest, times: [at, ...(again || [])], dur, mask: maskOf(l.leds) };
  });
}
const windows = (it) => it.times.map((t) => [t, it.dur === null ? Infinity : t + it.dur]);
const overlap = (a, b) => windows(a).some(([a0, a1]) => windows(b).some(([b0, b1]) => a0 < b1 && b0 < a1));
const layerOf = (it) => {
  const l = { ...it.rest, at: it.times[0] };
  if (it.times.length > 1) l.again = it.times.slice(1);
  return l;
};

// Would these items, in some order, draw as the original did? Each pair of original layers that
// light the same LED at the same time must keep its order, so the items (each now at one place in
// the list) must not need to go both before and after each other, directly or through others.
function canOrder(items, clash) {
  const n = items.length, after = items.map(() => []), into = new Array(n).fill(0);
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
    if (x === y) continue;
    if (items[x].members.some((a) => items[y].members.some((b) => a < b && clash[a][b]))) { after[x].push(y); into[y]++; }
  }
  const ready = [];
  for (let x = 0; x < n; x++) if (!into[x]) ready.push(x);
  let seen = 0;
  while (ready.length) { const x = ready.pop(); seen++; for (const y of after[x]) if (!--into[y]) ready.push(y); }
  return seen === n ? after : null;
}

export function squeeze(recipe, { drive, check = true } = {}) {
  const anim = normalise(recipe, ANY);
  const bytesOf = (a) => pack(a, ANY).length;
  const before = { layers: anim.layers.length, bytes: bytesOf(anim) };
  const same = { recipe, anim, ...before, before, squeezed: false };
  if (anim.layers.length < 2) return same;
  const meta = { type: 'animation', name: anim.name, board: anim.board, timing: anim.timing, once: anim.once };
  if (anim.over) meta.over = true;
  if (anim.recolour) meta.recolour = anim.recolour;
  if (anim.custom) meta.custom = anim.custom;
  const step = STEP[anim.timing], tb = (t) => (Math.round(t / step) < 128 ? 1 : 2);
  // a layer's own bytes, with its LED byte and start time (a glow on all LEDs for a 16th is 5)
  const G = { move: 'glow', leds: 'all', at: 0, for: step };
  const base = bytesOf({ ...meta, layers: [G] }) - 5;
  const own = (it) => bytesOf({ ...meta, layers: [layerOf(it)] }) - base;

  const orig = itemsOf(anim);
  const clash = orig.map((a, i) => orig.map((b, j) => i !== j && (a.mask & b.mask) !== 0 && overlap(a, b)));
  let items = orig.map((it) => ({ ...it }));

  // 1. the same layer at other times: one layer that plays again
  const tooMany = anim.layers.length > MAX_LAYERS;
  const keys = [...new Set(items.map((it) => it.key).filter((k) => k !== null))];
  for (const key of keys) {
    const group = items.filter((it) => it.key === key);
    if (group.length < 2) continue;
    let into = group[0];
    for (const it of group.slice(1)) {
      const times = [...into.times, ...it.times].sort((a, b) => a - b);
      // each time must end before the next starts (a layer plays from its latest start), at most 64 again
      if (times.length - 1 > MAX_AGAIN || times.some((t, k) => k && (near(t, times[k - 1]) || times[k - 1] + into.dur > t + 1e-9))) { into = it; continue; }
      const merged = { ...into, members: [...into.members, ...it.members], times };
      const next = items.filter((x) => x !== into && x !== it).concat([merged]);
      if (!canOrder(next, clash)) { into = it; continue; }
      if (!tooMany && own(merged) > own(into) + own(it)) { into = it; continue; }   // (only to save bytes, unless it must lose layers)
      items = next;
      into = merged;
    }
  }

  // 2. the order that takes the fewest bytes: start from the items no one must come before, and
  // keep the BEAM cheapest partial lists
  const after = canOrder(items, clash);
  const n = items.length, cost = items.map(own);
  const need = items.map(() => 0);
  after.forEach((ys) => ys.forEach((y) => need[y]++));
  const startOf = (x) => items[x].times[0], endOf = (x) => items[x].times[items[x].times.length - 1] + (items[x].dur ?? 0);
  const saving = (p, x) => {
    if (p < 0) return 0;
    let s = items[p].mask === items[x].mask ? 1 : 0;
    const t = startOf(x);
    if (t !== 0 && (near(t, startOf(p)) || (items[p].dur !== null && near(t, endOf(p))))) s += tb(t);
    return s;
  };
  // keep the original order where it costs nothing more (ties go to the lower original layer)
  const firstOf = items.map((it) => Math.min(...it.members));
  const lower = (o, p) => { for (let k = 0; k < o.length; k++) if (firstOf[o[k]] !== firstOf[p[k]]) return firstOf[o[k]] < firstOf[p[k]]; return false; };
  let beam = [{ order: [], placed: 0n, need: need.slice(), cost: 0 }];
  for (let k = 0; k < n; k++) {
    const nextBeam = new Map();
    for (const b of beam) {
      const last = b.order.length ? b.order[b.order.length - 1] : -1;
      for (let x = 0; x < n; x++) {
        if (b.need[x] !== 0) continue;
        const c = b.cost + cost[x] - saving(last, x), placed = b.placed | (1n << BigInt(x));
        const id = `${placed.toString(36)}|${x}`, was = nextBeam.get(id), order = [...b.order, x];
        if (was && (was.cost < c || (was.cost === c && !lower(order, was.order)))) continue;
        const nd = b.need.slice();
        nd[x] = -1;
        for (const y of after[x]) nd[y]--;
        nextBeam.set(id, { order, placed, need: nd, cost: c });
      }
    }
    beam = [...nextBeam.values()].sort((p, q) => p.cost - q.cost || (lower(p.order, q.order) ? -1 : 1)).slice(0, BEAM);
  }
  const best = beam[0].order;
  const out = { ...meta, layers: best.map((x) => layerOf(items[x])) };
  for (const k of ['notes', 'tracks']) if (recipe[k] !== undefined) out[k] = recipe[k];
  const outAnim = normalise(out, ANY);
  const got = { layers: outAnim.layers.length, bytes: bytesOf(outAnim) };
  if (got.layers > before.layers || got.bytes > before.bytes || (got.layers === before.layers && got.bytes === before.bytes)) return same;
  if (check && !sameFrames(anim, outAnim, drive)) return { ...same, failed: true };
  // the recipe as it was written (name, notes, tracks), with the squeezed layers
  const squeezed = { ...recipe, layers: out.layers };
  return { recipe: squeezed, anim: outAnim, ...got, before, squeezed: true };
}

// Every LED of every frame the same? Drawn every 1/32 beat (5 ms), over a made-up normal look
// (each LED its own colour and level) if it plays over one, with kicks and snares of every size.
export function sameFrames(a, b, drive) {
  const len = length(a);
  if (len === null || length(b) === null || Math.abs(len - length(b)) > 1e-6) return false;
  const fine = FINE[a.timing], end = Math.round(len * fine) + fine, dt = a.timing === 'beats' ? fine / 32 : 5;
  const pal = palette({});
  const under = a.over ? drive.heights.map((_, i) => ({ c: [(i * 71 + 30) & 255, (i * 113 + 90) & 255, (i * 37 + 200) & 255], l: (i * 29 + 60) & 255 })) : null;
  for (let t = 0, k = 0; t < end; t += dt, k++) {
    const music = { bar: t & 65535, beats: t, kick: (k * 53) & 255, snare: (k * 97 + 40) & 255, loud: 1600 + ((k * 7) & 255) };
    const ctx = { drive, palette: pal, music, ...(under ? { under } : {}) };
    const x = levels(a, t, ctx), y = levels(b, t, ctx);
    for (let i = 0; i < x.length; i++) if (x[i].l !== y[i].l || x[i].c.some((v, j) => v !== y[i].c[j])) return false;
  }
  return true;
}
