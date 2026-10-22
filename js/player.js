// The animation player (roadmap R2): one small player that knows a handful of moves, and
// animations written as short recipes of layers. The same player will run on the drives (R5
// Pulse, R6 Core), so the maths here is whole numbers only and every division is of a number
// that isn't negative (C and JavaScript then agree). docs/ANIMATION-FORMAT.md is the spec.
//
//   { type: 'animation', name: 'Drift', board: 'core', timing: 'ms', once: false,
//     layers: [{ move: 'breathe', leds: [3, 4], colour: 1, low: 70, high: 255, every: 4000 }, ...] }
//
// A layer lights some LEDs with one move, from `at` for `for` (ms, or beats when timing is
// 'beats'); later layers are drawn over earlier ones. One-shot animations (once: true, like a
// start-up) can be written as a step list: steps: [{ for: 1200, layers: [...] }, ...].
// Colours are slots in the colour set, never "red": 1 red, 2 orange, 3 white, 4 yellow (Core's
// fourth colour; Pulse uses its orange), 5 the station's warm white, 0 off. A recipe can also
// carry up to 10 fixed colours of its own, custom: [[r, g, b], ...], which are slots 6 to 15.

const fl = Math.floor;

// ---------------------------------------------------------------- the moves and their numbers
export const CURVES = ['linear', 'ease', 'in', 'out', 'exp'];
export const BLENDS = ['over', 'mask', 'tint', 'lift'];
export const SIDES = ['above', 'below'];
export const COLOUR_SLOTS = 6; // from the colour set (0-5); the recipe's own colours follow
export const MAX_CUSTOM = 10;   // slots 6-15: a colour is 4 bits in fade's and drift's bytes
export const STATION_WHITE = [255, 247, 234]; // the box's LED line white (l, l - l/32, l - l/12)

// Each move: its number in the bytes, its settings in byte order [name, type, default], and
// for some a style byte [name, bits, values (an enum) or null (yes/no)].
// Types: colour (0-5, or 6-15 from the recipe's custom), colour2 (from, to), colours (2-4 slots),
// level (0-255), levels (from, to), time (ms or beats), lag (signed time, plug to logo), pos (% of
// the drive, even, -256..254), pct (% of the drive, 1-255), hits (on ms, off ms, peak), u8.
export const MOVES = {
  glow:    { id: 0, params: [['colour', 'colour', 1], ['level', 'level', 255]] },
  fade:    { id: 1, needsFor: true, params: [['colour', 'colour2', [1, 1]], ['level', 'levels', [0, 255]]],
             style: [['blend', 2, BLENDS, 'over'], ['curve', 3, CURVES, 'ease']] },
  breathe: { id: 2, params: [['colour', 'colour', 1], ['low', 'level', 0], ['high', 'level', 255], ['every', 'time'], ['phase', 'time', 0]] },
  drift:   { id: 3, params: [['colours', 'colours'], ['level', 'level', 255], ['every', 'time'], ['phase', 'time', 0]] },
  pulse:   { id: 4, params: [['colour', 'colour', 1], ['low', 'level', 0], ['high', 'level', 255], ['every', 'time'], ['rise', 'time', 0], ['fall', 'time'], ['lag', 'lag', 0]],
             style: [['up', 3, CURVES, 'ease'], ['down', 3, CURVES, 'ease'], ['blend', 2, BLENDS, 'over']] },
  hits:    { id: 5, notOnPulse: true, ownLength: true, params: [['colour', 'colour', 1], ['fadeTo', 'level', 85], ['hits', 'hits']] },
  wave:    { id: 6, needsFor: true, params: [['colour', 'colour', 1], ['low', 'level', 0], ['high', 'level', 255], ['from', 'pos', 0], ['to', 'pos', 100], ['width', 'pct']],
             style: [['curve', 3, CURVES, 'ease'], ['round', 1, null, false], ['land', 1, null, false], ['back', 1, null, false], ['blend', 2, BLENDS, 'over']] },
  fill:    { id: 7, needsFor: true, params: [['colour', 'colour', 1], ['level', 'level', 255], ['from', 'pos', 0], ['to', 'pos', 100], ['edge', 'pct', 20]],
             style: [['curve', 3, CURVES, 'ease'], ['side', 1, SIDES, 'below'], ['blend', 2, BLENDS, 'over']] },
  wipe:    { id: 8, needsFor: true, params: [['colour', 'colour', 1], ['level', 'level', 255], ['from', 'pos', 0], ['to', 'pos', 100], ['crest', 'pct', 15], ['behind', 'pct', 40]],
             style: [['curve', 3, CURVES, 'ease']] },
  rainbow: { id: 9, params: [['level', 'level', 255], ['every', 'time'], ['phase', 'time', 0], ['lag', 'lag', 0], ['twist', 'u8', 0]] },
  kick:    { id: 10, beatsOnly: true, params: [['loud', 'u8', 85]] },
  twinkle: { id: 11, notOnPulse: true, params: [['colour', 'colour', 3], ['low', 'level', 0], ['high', 'level', 255], ['every', 'time'], ['chance', 'u8', 64]] },
  flicker: { id: 12, notOnPulse: true, params: [['colour', 'colour', 1], ['low', 'level', 0], ['high', 'level', 255], ['every', 'time']] },
};
// Pulse engine 2 has no room for these three (Jonny, 22 Oct 2026): a recipe for a Pulse can't use them.
export const PULSE_MOVES = Object.keys(MOVES).filter((m) => !MOVES[m].notOnPulse);
const MOVE_BY_ID = Object.fromEntries(Object.entries(MOVES).map(([k, m]) => [m.id, k]));
const MAX_LAYERS = 15, MAX_HITS = 40;

// Time units in the bytes: 10 ms, or 1/16 of a beat. Hit lengths: 5 ms, or 1/32 of a beat.
// The longest time: 32767 units (5.5 minutes), or for beats 8191 (512 beats less a 16th, ~3 minutes
// at 174 BPM), so the drives' players never need more than 32-bit maths (R5).
const STEP = { ms: 10, beats: 1 / 16 };
const MAXQ = { ms: 32767, beats: 8191 };
const HIT_STEP = { ms: 5, beats: 1 / 32 };

// ---------------------------------------------------------------- checking a recipe
class RecipeError extends Error {}
const fail = (where, msg) => { throw new RecipeError(`${where}: ${msg}`); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ledCount = (board) => (board === 'core' ? 6 : 8);

function quant(v, step, where, name, max) {
  if (!isNum(v) || v < 0) fail(where, `"${name}" must be a number, 0 or more (got ${JSON.stringify(v)}).`);
  const q = Math.round(v / step);
  if (q > max) {
    const ms = step === STEP.ms || step === HIT_STEP.ms;
    fail(where, `"${name}" is too long (${v}): the longest is ${+(max * step).toFixed(5)} ${ms ? 'ms' : 'beats'}.`);
  }
  if (q === 0 && v > 0) {
    const ms = step === STEP.ms || step === HIT_STEP.ms;
    fail(where, `"${name}" is ${v}, which is under one step (${ms ? `${step} ms` : `1/${Math.round(1 / step)} beat`}) and rounds to 0.${ms ? ' Times are in ms unless the recipe says "timing": "beats".' : ''}`);
  }
  return q;
}

// " (did you mean "colour"?)" for a word that's close to one of the right ones, else "".
const LIKELY = { color: 'colour', colors: 'colours', duration: 'for', length: 'for', start: 'at', delay: 'at', period: 'every', speed: 'every', brightness: 'level', led: 'leds', strobe: 'pulse', flash: 'pulse' };
function apart(a, b) { // how many letters to change, add or remove to turn a into b
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
function didYouMean(word, options, likely = LIKELY) {
  const w = String(word).toLowerCase();
  let best = options.includes(likely[w]) ? likely[w] : null;
  if (!best) {
    const near = options.map((o) => [o, apart(w, o.toLowerCase())]).sort((x, y) => x[1] - y[1])[0];
    if (near && near[1] <= (w.length <= 4 ? 1 : 2)) best = near[0];
  }
  return best ? ` (did you mean "${best}"?)` : '';
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const RECIPE_KEYS = ['type', 'name', 'board', 'timing', 'once', 'custom', 'notes', 'layers', 'steps'];
const RECIPE_LIKELY = { colours: 'custom', colors: 'custom', customcolours: 'custom', customcolors: 'custom', palette: 'custom', rgb: 'custom' };

// The recipe's own colours: a list of up to 10 [r, g, b], the first is colour 6.
function normCustom(v) {
  if (v === undefined) return [];
  const eg = 'like "custom": [[159, 255, 82]] (the first is colour 6, the next 7, and so on)';
  if (!Array.isArray(v)) fail('Recipe', `"custom" is a list of the recipe's own colours in square brackets, ${eg}.`);
  if (v.length > MAX_CUSTOM) fail('Recipe', `"custom" has ${v.length} colours; the most is ${MAX_CUSTOM} (colours 6 to 15).`);
  return v.map((c, k) => {
    if (!Array.isArray(c) || c.length !== 3 || !c.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
      fail('Recipe', `custom colour ${k + 1} (colour ${COLOUR_SLOTS + k}) must be [red, green, blue], each a whole number from 0 to 255, like [159, 255, 82] (got ${JSON.stringify(c)}).`);
    }
    return [...c];
  });
}

// The canonical recipe: steps flattened into layers with absolute `at`, every setting filled
// in and rounded to what the bytes hold. pack() and unpack() agree on this form exactly.
export function normalise(recipe) {
  if (!isObj(recipe)) throw new RecipeError('A recipe is an object like { "type": "animation", "layers": [...] }.');
  if (recipe.type !== undefined && recipe.type !== 'animation') fail('Recipe', `"type" must be "animation" (got ${JSON.stringify(recipe.type)}).`);
  for (const k of Object.keys(recipe)) if (!RECIPE_KEYS.includes(k)) fail('Recipe', `"${k}" isn't part of a recipe${didYouMean(k, RECIPE_KEYS, { ...LIKELY, ...RECIPE_LIKELY })}. A recipe has ${RECIPE_KEYS.join(', ')}.`);
  if (recipe.name !== undefined && typeof recipe.name !== 'string') fail('Recipe', '"name" must be text in quotes, like "Drop".');
  const board = recipe.board || 'any';
  if (!['core', 'pulse', 'any'].includes(board)) fail('Recipe', `board must be "core", "pulse" or "any" (got "${board}").`);
  const timing = recipe.timing || 'ms';
  if (!STEP[timing]) fail('Recipe', `timing must be "ms" or "beats" (got "${timing}").`);
  if (recipe.once !== undefined && typeof recipe.once !== 'boolean') fail('Recipe', '"once" must be true or false.');
  const once = !!recipe.once;
  const custom = normCustom(recipe.custom);
  const list = (v, where, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(where, `"${what}" must be a list in square brackets: [ ... ].`);
    return v;
  };
  const layerObj = (l, where) => { if (!isObj(l)) fail(where, 'each layer is written in curly brackets, like { "move": "glow", "colour": 1 }.'); };
  const flat = [], whereOf = [];
  list(recipe.layers, 'Recipe', 'layers').forEach((l, li) => { layerObj(l, `Layer ${li + 1}`); flat.push({ ...l }); whereOf.push(`Layer ${li + 1}`); });
  let stepAt = 0;
  list(recipe.steps, 'Recipe', 'steps').forEach((s, si) => {
    const where = `Step ${si + 1}`;
    if (!isObj(s)) fail(where, 'each step is written in curly brackets, like { "for": 4, "layers": [ ... ] }.');
    for (const k of Object.keys(s)) if (k !== 'for' && k !== 'layers') fail(where, `"${k}" isn't part of a step${didYouMean(k, ['for', 'layers'])}. A step has "for" (its length) and "layers".`);
    if (!isNum(s.for) || s.for <= 0) fail(where, 'each step needs a length ("for") more than 0.');
    const ls = list(s.layers, where, 'layers');
    if (!ls.length) fail(where, 'it has no layers. Give it at least one, like { "move": "glow", "colour": 0 } for dark.');
    ls.forEach((l, li) => {
      const at = `${where}, layer ${li + 1}`;
      layerObj(l, at);
      if (l.at !== undefined && (!isNum(l.at) || l.at < 0)) fail(at, `"at" must be a number, 0 or more (got ${JSON.stringify(l.at)}).`);
      const f = { ...l, at: stepAt + (l.at || 0) };
      if (l.for === undefined && !(MOVES[l.move] && MOVES[l.move].ownLength)) f.for = s.for; // hits keep their own length
      flat.push(f);
      whereOf.push(at);
    });
    stepAt += s.for;
  });
  if (!flat.length) fail('Recipe', 'it has no layers. Add "layers": [ ... ] (or "steps" for a one-shot).');
  if (flat.length > MAX_LAYERS) fail('Recipe', `it has ${flat.length} layers; the most is ${MAX_LAYERS}.`);
  const out = { type: 'animation', name: String(recipe.name || 'Untitled'), board, timing, once, layers: [] };
  if (custom.length) out.custom = custom;
  const step = STEP[timing], unit = (q) => +(q * step).toFixed(4);
  let prev = null;
  flat.forEach((l, i) => {
    const where = `${whereOf[i]}${typeof l.move === 'string' ? ` (${l.move})` : ''}`;
    const m = MOVES[l.move];
    if (l.move === undefined) fail(where, `it has no "move". Moves: ${Object.keys(MOVES).join(', ')}.`);
    if (!m) fail(where, `unknown move ${JSON.stringify(l.move)}${didYouMean(l.move, Object.keys(MOVES))}. Moves: ${Object.keys(MOVES).join(', ')}.`);
    if (m.beatsOnly && timing !== 'beats') fail(where, `"${l.move}" follows the music, so the recipe's timing must be "beats".`);
    if (m.notOnPulse && board === 'pulse') fail(where, `"${l.move}" isn't on a Pulse: there wasn't room for it on the Pulse's chip. Moves for a Pulse: ${PULSE_MOVES.join(', ')}.`);
    const c = { move: l.move, leds: normLeds(l.leds, board, where) };
    // when it starts: at the start, when the layer before ends, with it, or at a time of its own
    if (l.at !== undefined && (!isNum(l.at) || l.at < 0)) fail(where, `"at" must be a number, 0 or more (got ${JSON.stringify(l.at)}).`);
    const close = (a, b) => b !== null && b !== undefined && Math.abs(a - b) < 1e-6;
    let at = l.at || 0;
    if (at !== 0 && prev && close(at, prev.end)) at = prev.end;
    else if (at !== 0 && prev && close(at, prev.at)) at = prev.at;
    else if (at !== 0) at = unit(quant(at, step, where, 'at', MAXQ[timing]));
    let len = null;
    if (m.ownLength) {
      if (l.for !== undefined) fail(where, 'hits sets its own length from its hits; leave "for" out.');
    } else if (l.for !== undefined && l.for !== null && l.for !== 0) {
      len = unit(quant(l.for, step, where, 'for', MAXQ[timing]));
    } else if (m.needsFor) fail(where, `"${l.move}" needs a length ("for").`);
    c.at = at;
    if (len !== null) c.for = len;
    for (const [name, type, def] of m.params) c[name] = normParam(l[name] === undefined ? def : l[name], type, name, where, timing, custom.length);
    for (const [name, , values, def] of m.style || []) {
      const v = l[name] === undefined ? def : l[name];
      if (values ? !values.includes(v) : typeof v !== 'boolean') fail(where, values ? `"${name}" must be one of ${values.join(', ')} (got ${JSON.stringify(v)}).` : `"${name}" must be true or false.`);
      c[name] = v;
    }
    checkMove(c, where);
    const known = ['move', 'leds', 'at', ...(m.ownLength ? [] : ['for']), ...m.params.map((p) => p[0]), ...(m.style || []).map((p) => p[0])];
    for (const k of Object.keys(l)) if (!known.includes(k)) fail(where, `"${k}" isn't a setting of "${l.move}"${didYouMean(k, known)}. Its settings: ${known.slice(1).join(', ')}.`);
    const dur = m.ownLength ? hitsLength(c.hits) : len;
    prev = { at, end: dur === null ? null : +(at + dur).toFixed(5) };
    out.layers.push(c);
  });
  if (once && length(out) === null) fail('Recipe', 'a one-shot animation ("once") needs at least one layer with a length.');
  return out;
}

function normLeds(leds, board, where) {
  const n = ledCount(board);
  if (leds === undefined || leds === 'all') return Array.from({ length: n }, (_, i) => i + 1);
  if (!Array.isArray(leds) || !leds.length) fail(where, '"leds" must be "all" or a list of LED numbers, like [1, 2].');
  for (const x of leds) if (!Number.isInteger(x) || x < 1 || x > n) fail(where, `LED ${JSON.stringify(x)} isn't on the board (1 to ${n}).`);
  return [...new Set(leds)].sort((a, b) => a - b);
}

function normParam(v, type, name, where, timing, customs = 0) {
  const int = (x, lo, hi) => {
    if (!Number.isInteger(x) || x < lo || x > hi) fail(where, `"${name}" must be a whole number from ${lo} to ${hi} (got ${JSON.stringify(x)}).`);
    return x;
  };
  // 0-5 from the colour set, 6-15 the recipe's own (only as many as its "custom" list has)
  const slot = (x, lo) => {
    int(x, lo, COLOUR_SLOTS + MAX_CUSTOM - 1);
    if (x >= COLOUR_SLOTS + customs) {
      fail(where, customs
        ? `colour ${x} isn't one of this recipe's own colours: its "custom" list has ${customs} (colour${customs === 1 ? ' 6' : `s 6 to ${COLOUR_SLOTS + customs - 1}`}). Add more to "custom", or use one of those.`
        : `colour ${x} is one of the recipe's own colours (6 to 15), but the recipe has none. Add "custom": [[r, g, b]] to the recipe: the first is colour 6.`);
    }
    return x;
  };
  const step = STEP[timing];
  switch (type) {
    case 'colour': return slot(v, 0);
    case 'colour2': { const a = Array.isArray(v) ? v : [v, v]; if (a.length !== 2) fail(where, `"${name}" is a colour or [from, to].`); return a.map((x) => slot(x, 0)); }
    case 'colours': {
      if (!Array.isArray(v) || v.length < 2 || v.length > 4) fail(where, `"${name}" must list 2 to 4 colours, like [1, 2].`);
      return v.map((x) => slot(x, 1));
    }
    case 'level': case 'u8': return int(v, 0, 255);
    case 'levels': { const a = Array.isArray(v) ? v : [v, v]; if (a.length !== 2) fail(where, `"${name}" is a level or [from, to].`); return a.map((x) => int(x, 0, 255)); }
    case 'time': {
      if (v === undefined) fail(where, `"${name}" is needed.`);
      return +(quant(v, step, where, name, MAXQ[timing]) * step).toFixed(4);
    }
    case 'lag': {
      if (!isNum(v)) fail(where, `"${name}" must be a number.`);
      const q = Math.round(v / step);
      if (q < -127 || q > 127) fail(where, `"${name}" must be within ±${127 * step} ${timing}.`);
      return +(q * step).toFixed(4);
    }
    case 'pos': {
      if (!isNum(v)) fail(where, `"${name}" must be a number (% of the drive: 0 the plug, 100 the logo).`);
      const q = Math.round(v / 2);
      if (q < -128 || q > 127) fail(where, `"${name}" must be from -256 to 254 (% of the drive).`);
      return q * 2;
    }
    case 'pct': {
      if (v === undefined) fail(where, `"${name}" is needed (% of the drive).`);
      if (!isNum(v)) fail(where, `"${name}" must be a number (% of the drive, 1 to 255).`);
      return int(Math.round(v), 1, 255);
    }
    case 'hits': {
      if (!Array.isArray(v) || !v.length || v.length > MAX_HITS) fail(where, `"hits" must list 1 to ${MAX_HITS} hits, each [on, off, peak].`);
      const hs = HIT_STEP[timing];
      return v.map((h, k) => {
        if (!Array.isArray(h) || h.length !== 3) fail(where, `hit ${k + 1} must be [on, off, peak].`);
        return [+(quant(h[0], hs, where, `hit ${k + 1} on`, 255) * hs).toFixed(5), +(quant(h[1], hs, where, `hit ${k + 1} off`, 255) * hs).toFixed(5), int(h[2], 0, 255)];
      });
    }
  }
  throw new Error(`unknown type ${type}`);
}

function checkMove(c, where) {
  if ('every' in c && !(c.every > 0)) fail(where, '"every" must be more than 0.');
  if (c.move === 'pulse' && c.rise + c.fall > c.every + 1e-9) fail(where, '"rise" and "fall" together must fit in "every".');
}

const hitsLength = (hits) => +hits.reduce((n, h) => n + h[0] + h[1], 0).toFixed(5);

// When each layer starts and ends (in ms or beats), and the animation's length: a one-shot's
// end, or a loop's cycle (null: a loop with no timed layers just runs).
function layerTimes(anim) {
  return anim.layers.map((l) => {
    const dur = MOVES[l.move].ownLength ? hitsLength(l.hits) : (l.for || null);
    return { at: l.at, end: dur === null ? null : +(l.at + dur).toFixed(5) };
  });
}
export function length(anim) {
  const ends = layerTimes(anim).map((t) => t.end).filter((e) => e !== null);
  return ends.length ? Math.max(...ends) : null;
}

// ---------------------------------------------------------------- bytes
// Animation: 1 header byte (bits 0-3 layer count, bit 4 timing in beats, bit 5 one-shot, bit 6
// it has colours of its own), then if bit 6 a count byte (1-10) and 3 bytes (r, g, b) for each
// of them (colours 6, 7, ...), then each layer: 1 byte (bits 0-3 move, bits 4-5 start: 0 at the start, 1 when the layer before
// ends, 2 with the layer before, 3 at its own time; bit 6 has a length; bit 7 same LEDs as the
// layer before), the LED byte (bit 0 = LED 1) unless bit 7, its start time if 3, its length if
// bit 6, then the move's settings in the order of MOVES. A time is 1 byte (0xxxxxxx, 0-127
// units) or 2 (1xxxxxxx xxxxxxxx, 0-32767 units). Units: 10 ms or 1/16 beat.
function putTime(out, q) { if (q < 128) out.push(q); else out.push(0x80 | (q >> 8), q & 255); }
function getTime(b, p) { const x = b[p.i++]; return x < 128 ? x : ((x & 127) << 8) | b[p.i++]; }
const mask = (leds) => leds.reduce((m, n) => m | (1 << (n - 1)), 0);
const unmask = (m) => [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => m & (1 << (n - 1)));

export function pack(recipe) {
  const a = normalise(recipe), step = STEP[a.timing], hs = HIT_STEP[a.timing];
  const out = [a.layers.length | (a.timing === 'beats' ? 16 : 0) | (a.once ? 32 : 0) | (a.custom ? 64 : 0)];
  if (a.custom) { out.push(a.custom.length); for (const c of a.custom) out.push(...c); }
  const times = layerTimes(a);
  a.layers.forEach((l, i) => {
    const m = MOVES[l.move], prev = times[i - 1];
    const startMode = l.at === 0 ? 0 : prev && prev.end !== null && Math.abs(l.at - prev.end) < 1e-9 ? 1 : prev && Math.abs(l.at - prev.at) < 1e-9 ? 2 : 3;
    const same = i > 0 && mask(l.leds) === mask(a.layers[i - 1].leds);
    out.push(m.id | (startMode << 4) | (l.for ? 64 : 0) | (same ? 128 : 0));
    if (!same) out.push(mask(l.leds));
    if (startMode === 3) putTime(out, Math.round(l.at / step));
    if (l.for) putTime(out, Math.round(l.for / step));
    for (const [name, type] of m.params) {
      const v = l[name];
      if (type === 'colour' || type === 'level' || type === 'u8' || type === 'pct') out.push(v);
      else if (type === 'colour2') out.push((v[0] << 4) | v[1]);
      else if (type === 'colours') { const s = [...v, 0, 0, 0].slice(0, 4); out.push((s[0] << 4) | s[1], (s[2] << 4) | s[3]); }
      else if (type === 'levels') out.push(v[0], v[1]);
      else if (type === 'time') putTime(out, Math.round(v / step));
      else if (type === 'lag') out.push(Math.round(v / step) & 255);
      else if (type === 'pos') out.push((v / 2) & 255);
      else if (type === 'hits') { out.push(v.length); for (const h of v) out.push(Math.round(h[0] / hs), Math.round(h[1] / hs), h[2]); }
    }
    if (m.style) {
      let s = 0, shift = 0;
      for (const [name, bits, values] of m.style) { s |= (values ? values.indexOf(l[name]) : l[name] ? 1 : 0) << shift; shift += bits; }
      out.push(s);
    }
  });
  return Uint8Array.from(out);
}

// Bytes back to the canonical recipe. The name and board aren't in the bytes: pass them.
export function unpack(bytes, { name = 'Untitled', board = 'any' } = {}) {
  const b = bytes, p = { i: 0 };
  const need = (n) => { if (p.i + n > b.length) throw new RecipeError('The animation bytes stop part way through.'); };
  need(1);
  const h = b[p.i++], count = h & 15, timing = h & 16 ? 'beats' : 'ms', once = !!(h & 32);
  if (h & 128) throw new RecipeError('The animation\'s first byte has bit 7 set, which no recipe uses.');
  const step = STEP[timing], hs = HIT_STEP[timing], unit = (q) => +(q * step).toFixed(4);
  const anim = { type: 'animation', name, board, timing, once, layers: [] };
  if (h & 64) {
    need(1);
    const n = b[p.i++];
    if (n < 1 || n > MAX_CUSTOM) throw new RecipeError(`The animation says it has ${n} colours of its own; it can have 1 to ${MAX_CUSTOM}.`);
    need(n * 3);
    anim.custom = [];
    for (let k = 0; k < n; k++, p.i += 3) anim.custom.push([b[p.i], b[p.i + 1], b[p.i + 2]]);
  }
  let leds = null, prev = null;
  for (let k = 0; k < count; k++) {
    need(1);
    const x = b[p.i++], move = MOVE_BY_ID[x & 15], m = MOVES[move];
    if (!m) throw new RecipeError(`Layer ${k + 1} has an unknown move number ${x & 15}.`);
    if (!(x & 128)) { need(1); leds = unmask(b[p.i++]); } else if (!leds) throw new RecipeError('The first layer must give its LEDs.');
    const mode = (x >> 4) & 3;
    const l = { move, leds: [...leds] };
    if (mode === 3) { need(1); l.at = unit(getTime(b, p)); }
    if (x & 64) { need(1); l.for = unit(getTime(b, p)); }
    l.at = mode === 0 ? 0 : mode === 1 ? prev.end : mode === 2 ? prev.at : l.at;
    if (l.at === null || l.at === undefined) throw new RecipeError(`Layer ${k + 1} starts when the layer before ends, but that layer has no end.`);
    const forV = l.for; delete l.for;
    const ordered = { move: l.move, leds: l.leds, at: l.at };
    if (forV !== undefined) ordered.for = forV;
    for (const [name, type] of m.params) {
      need(1);
      if (type === 'colour' || type === 'level' || type === 'u8' || type === 'pct') ordered[name] = b[p.i++];
      else if (type === 'colour2') { const v = b[p.i++]; ordered[name] = [v >> 4, v & 15]; }
      else if (type === 'colours') { need(2); const s = [b[p.i] >> 4, b[p.i] & 15, b[p.i + 1] >> 4, b[p.i + 1] & 15]; p.i += 2; ordered[name] = s.filter((c, j) => j < 2 || c); }
      else if (type === 'levels') { need(2); ordered[name] = [b[p.i], b[p.i + 1]]; p.i += 2; }
      else if (type === 'time') ordered[name] = unit(getTime(b, p));
      else if (type === 'lag') ordered[name] = unit((b[p.i++] << 24) >> 24);
      else if (type === 'pos') ordered[name] = ((b[p.i++] << 24) >> 24) * 2;
      else if (type === 'hits') {
        const n = b[p.i++];
        need(n * 3);
        ordered[name] = [];
        for (let j = 0; j < n; j++, p.i += 3) ordered[name].push([+(b[p.i] * hs).toFixed(5), +(b[p.i + 1] * hs).toFixed(5), b[p.i + 2]]);
      }
    }
    if (m.style) {
      need(1);
      let s = b[p.i++];
      for (const [name, bits, values] of m.style) { const v = s & ((1 << bits) - 1); s >>= bits; ordered[name] = values ? values[v] : !!v; }
    }
    const dur = m.ownLength ? hitsLength(ordered.hits) : (ordered.for || null);
    prev = { at: ordered.at, end: dur === null ? null : +(ordered.at + dur).toFixed(5) };
    anim.layers.push(ordered);
  }
  if (p.i !== b.length) throw new RecipeError(`The animation bytes have ${b.length - p.i} left over at the end.`);
  return anim;
}

// ---------------------------------------------------------------- where the LEDs are
// Heights from the plug (0) to the logo (10000), from the drive profile. LEDs the profile has no
// position for (on the back of the board) take the height of the front LED they face.
const FACING = { core: { 4: 3, 5: 1, 6: 2 }, pulse: { 4: 3, 6: 5, 7: 1, 8: 2 } };
export function makeDrive(profile) {
  const ys = {};
  for (const l of profile.leds) ys[l.led] = l.y;
  const facing = FACING[profile.family] || {};
  const y = [];
  for (let n = 1; n <= profile.count; n++) {
    if (ys[n] !== undefined) y.push(ys[n]);
    else if (ys[facing[n]] !== undefined) y.push(ys[facing[n]]);
    else {
      const g = Object.values(profile.groups || {}).find((m) => m.includes(n));
      const known = (g || []).map((k) => ys[k]).filter((v) => v !== undefined);
      y.push(known.length ? known.reduce((s, v) => s + v, 0) / known.length : null);
    }
  }
  const have = y.filter((v) => v !== null), lo = Math.min(...have), hi = Math.max(...have);
  return fromHeights(y.map((v) => (v === null || hi === lo ? 0 : Math.round((v - lo) * 10000 / (hi - lo)))));
}
// Evenly spaced sections, as today's engines place them (Pulse bottom, middle, top; Core outer, inner).
const SECTIONS = { core: [0, 0, 1, 1, 0, 0], pulse: [0, 0, 1, 1, 2, 2, 0, 0] };
export function sectionDrive(family) {
  const s = SECTIONS[family], top = Math.max(...s);
  return fromHeights(s.map((v) => Math.round(v * 10000 / top)));
}
function fromHeights(heights) {
  // rank: how many lower-numbered LEDs share this height (a rainbow's twist turns each one on)
  const ranks = heights.map((h, i) => heights.slice(0, i).filter((x) => x === h).length);
  return { count: heights.length, heights, ranks };
}

// The colour slots from a colour set ({ red, orange, white, yellow }, any case): 0-5. A recipe's
// own colours (slots 6-15) are added when it plays (levels()).
export function palette(set = {}) {
  const get = (k) => set[k] || set[k.toUpperCase()];
  const red = get('red') || [255, 0, 0], orange = get('orange') || [255, 45, 0];
  return [[0, 0, 0], red, orange, get('white') || [255, 235, 200], get('yellow') || orange, STATION_WHITE];
}

// ---------------------------------------------------------------- the maths (whole numbers)
const ease = (x) => fl((x * x * (765 - 2 * x)) / 65025);
const EXP = [255, 199, 155, 120, 94, 73, 57, 44, 35, 27, 21, 16, 13, 10, 8, 6, 5, 4, 3, 2, 2, 1, 1, 1]; // exp(-x) × 255, x in quarters
function expFall(x) { const u = fl(x * 5888 / 255), i = u >> 8; return i >= 23 ? 0 : EXP[i] - (((EXP[i] - EXP[i + 1]) * (u & 255)) >> 8); }
const CURVE = {
  linear: (x) => x, ease, in: (x) => fl(x * x / 255), out: (x) => 255 - fl((255 - x) * (255 - x) / 255), exp: (x) => 255 - expFall(x),
};
const prog = (t, len) => (t >= len ? 255 : t <= 0 ? 0 : fl(t * 255 / len));
const lerp = (a, b, k) => (b >= a ? a + fl((b - a) * k / 255) : a - fl((a - b) * k / 255));
const mix = (a, b, k) => [0, 1, 2].map((i) => fl((a[i] * (255 - k) + b[i] * k) / 255));
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mod = (a, n) => ((a % n) + n) % n;
function hash(a, b) { // a small repeatable random number, 0-255 (as the plug-in animation's sparkle)
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h & 255;
}

// Inside the player, time is whole ms, or 1/65536 of a bar (beats × 16384), and positions are
// 1/10000 of the drive. These turn a recipe's numbers into those.
const FINE = { ms: 1, beats: 16384 };
function prepare(anim) {
  if (anim._prep) return anim._prep;
  const k = FINE[anim.timing], T = (v) => Math.round(v * k);
  const times = layerTimes(anim);
  const layers = anim.layers.map((l, i) => {
    const q = { ...l, mask: mask(l.leds), at: T(times[i].at), end: times[i].end === null ? Infinity : T(times[i].end), blend: l.blend || 'over' };
    for (const key of ['every', 'phase', 'rise', 'fall', 'lag', 'for']) if (key in l) q[key] = T(l[key]);
    for (const key of ['from', 'to']) if (key in l) q[key] = l[key] * 100;
    for (const key of ['width', 'edge', 'crest', 'behind']) if (key in l) q[key] = l[key] * 100;
    if (l.hits) q.hits = l.hits.map(([on, off, peak]) => [T(on), T(off), peak]);
    if (anim.timing === 'beats' && q.every && 65536 % q.every === 0) q.locked = true; // lines up with the bar
    return q;
  });
  const len = length(anim);
  const prep = { layers, length: len === null ? null : T(len), fine: k };
  Object.defineProperty(anim, '_prep', { value: prep, enumerable: false });
  return prep;
}

// How late a layer reaches height h: lag > 0 spreads up from the plug, lag < 0 down from the logo.
const delay = (lag, h) => (lag >= 0 ? fl(lag * h / 10000) : fl(-lag * (10000 - h) / 10000));

// One layer's colour (a slot's rgb) and value (0-255) for LED i at the layer's own time t.
function moveAt(q, t, i, ctx) {
  const pal = ctx.palette, h = ctx.drive.heights[i];
  switch (q.move) {
    case 'glow': return [pal[q.colour], q.level];
    case 'fade': { const k = CURVE[q.curve](prog(t, q.for)); return [mix(pal[q.colour[0]], pal[q.colour[1]], k), lerp(q.level[0], q.level[1], k)]; }
    case 'breathe': {
      const p = fl((mod(t + q.phase, q.every)) * 512 / q.every), w = p < 256 ? 255 - p : p - 256;
      return [pal[q.colour], lerp(q.low, q.high, ease(w))];
    }
    case 'drift': {
      const n = q.colours.length, tt = mod(t + q.phase, q.every * n), s = fl(tt / q.every);
      return [mix(pal[q.colours[s]], pal[q.colours[(s + 1) % n]], ease(prog(tt % q.every, q.every))), q.level];
    }
    case 'pulse': {
      const d = delay(q.lag, h), f = q.locked ? mod(ctx.music.bar - d, q.every) : t - d < 0 ? q.every - 1 : mod(t - d, q.every);
      let s = 0;
      if (f < q.rise) s = CURVE[q.up](prog(f, q.rise));
      else if (f - q.rise < q.fall) s = 255 - CURVE[q.down](prog(f - q.rise, q.fall));
      return [pal[q.colour], lerp(q.low, q.high, s)];
    }
    case 'hits': {
      let tt = t;
      for (const [on, off, peak] of q.hits) {
        if (tt < on) return [pal[q.colour], peak - fl(peak * (255 - q.fadeTo) * prog(tt, on) / 65025)];
        tt -= on;
        if (tt < off) return [pal[q.colour], 0];
        tt -= off;
      }
      return [pal[q.colour], 0];
    }
    case 'wave': {
      const half = fl(q.for / 2);
      const p = q.back ? (t < half ? prog(t, half) : 255 - prog(t - half, half)) : prog(t, q.for);
      const c = q.from + (q.to >= q.from ? fl((q.to - q.from) * CURVE[q.curve](p) / 255) : -fl((q.from - q.to) * CURVE[q.curve](p) / 255));
      const dist = Math.abs(h - c);
      let band;
      if (q.round) { const x = dist >= q.width ? 255 : fl(dist * 255 / q.width), g = fl((65025 - x * x) / 255); band = fl(g * g / 255); }
      else band = dist >= q.width ? 0 : 255 - fl(dist * 255 / q.width);
      if (q.land && ((q.to > q.from && h >= 10000 && c >= h) || (q.to < q.from && h <= 0 && c <= h))) band = 255;
      return [pal[q.colour], lerp(q.low, q.high, band)];
    }
    case 'fill': {
      const k = CURVE[q.curve](prog(t, q.for));
      const front = q.to >= q.from ? q.from + fl((q.to - q.from) * k / 255) : q.from - fl((q.from - q.to) * k / 255);
      const x = (q.side === 'above' ? h - front : front - h) + fl(q.edge / 2);
      const a = x <= 0 ? 0 : x >= q.edge ? 255 : fl(x * 255 / q.edge);
      return [pal[q.colour], fl(q.level * a / 255)];
    }
    case 'rainbow': {
      const tt = t - delay(q.lag, h);
      const hue = ((tt <= 0 ? 0 : fl((tt + q.phase) * 256 / q.every)) + ctx.drive.ranks[i] * q.twist) & 255;
      return [wheel(hue), q.level];
    }
    case 'kick': {
      const g = clamp(Math.trunc((ctx.music.loud - (q.loud - 3) * 16) * 255 / 48));
      return [null, fl(ctx.music.kick * g / 255)];
    }
    case 'twinkle': {
      const slot = fl(t / q.every), f = prog(t - slot * q.every, q.every);
      if (hash(i + 1, slot) >= q.chance) return [pal[q.colour], q.low];
      return [pal[q.colour], lerp(q.low, q.high, f < 32 ? ease(f * 8) : 255 - ease(fl((f - 32) * 255 / 223)))];
    }
    case 'flicker': {
      const slot = fl(t / q.every), k = ease(prog(t - slot * q.every, q.every));
      return [pal[q.colour], lerp(q.low, q.high, lerp(hash(i + 1, slot), hash(i + 1, slot + 1), k))];
    }
  }
  return [[0, 0, 0], 0];
}
function wheel(h) {
  if (h < 85) return [255 - h * 3, h * 3, 0];
  if (h < 170) { h -= 85; return [0, 255 - h * 3, h * 3]; }
  h -= 170; return [h * 3, 0, 255 - h * 3];
}

// The wipe: a crest of colour sweeps from -> to and leaves the next section behind it.
function wipeAt(q, t, i, ctx) {
  const k = CURVE[q.curve](prog(t, q.for)), h = ctx.drive.heights[i], pal = ctx.palette;
  const front = q.to >= q.from ? q.from + fl((q.to - q.from) * k / 255) : q.from - fl((q.from - q.to) * k / 255);
  const d = q.to >= q.from ? front - h : h - front;
  const next = ctx.next ? ctx.next(i) : { c: [0, 0, 0], l: 0 };
  if (d < -q.crest) return { c: pal[q.colour], l: 0 };
  if (d < 0) return { c: pal[q.colour], l: fl(q.level * (d + q.crest) / q.crest) };
  if (d < q.behind) { const m = fl(d * 255 / q.behind); return { c: mix(pal[q.colour], next.c, m), l: lerp(q.level, next.l, m) }; }
  return { c: next.c, l: next.l };
}

// Every LED's colour and level (0-255) at time t into the animation: whole ms, or for beat-timed
// ones 1/65536 bars since it started. ctx: { drive, palette, music: { bar, kick, loud }, next }.
export function levels(anim, t, ctx) {
  const prep = prepare(anim), n = ctx.drive.count;
  if (anim.custom) ctx = { ...ctx, palette: ctx.palette.slice(0, COLOUR_SLOTS).concat(anim.custom) };
  const out = Array.from({ length: n }, () => ({ c: [0, 0, 0], l: 0 }));
  if (t < 0) return out;
  if (!anim.once && prep.length !== null) t %= prep.length;
  for (const q of prep.layers) {
    if (t < q.at || t >= q.end) continue;
    const lt = t - q.at;
    for (let i = 0; i < n; i++) {
      if (!(q.mask & (1 << i))) continue;
      const cur = out[i];
      if (q.move === 'wipe') { out[i] = wipeAt(q, lt, i, ctx); continue; }
      const [c, v] = moveAt(q, lt, i, ctx);
      const blend = q.move === 'kick' ? 'lift' : q.blend;
      if (blend === 'over') { cur.c = c; cur.l = v; }
      else if (blend === 'mask') cur.l = fl(cur.l * v / 255);
      else if (blend === 'tint') cur.c = mix(cur.c, c, v);
      else if (blend === 'lift') cur.l += fl((255 - cur.l) * v / 255);
    }
  }
  return out;
}

// What the LEDs are sent: the level is squared (as both engines do, so dim looks dim), then the
// routine's brightness.
export function toPixels(lv, brightness = 255) {
  return lv.map(({ c, l }) => {
    let k = fl(l * l / 255);
    k = fl(k * brightness / 255);
    return [fl(c[0] * k / 255), fl(c[1] * k / 255), fl(c[2] * k / 255)];
  });
}

// A steady beat clock when there's no music: bars at `bpm` from time 0.
export const steadyMusic = (ms, bpm = 174) => {
  const bars = Math.round(ms * bpm * 65536 / 240000);
  return { bar: bars & 65535, beats: bars, kick: 0, loud: 0 };
};

// ---------------------------------------------------------------- a show: sections in order
// sections: one-shot ms animations (start-up), then the one that keeps playing (ambient).
// music(ms) gives { bar, beats (1/65536 bars, always growing), kick, loud } at that time; without
// it beat-timed animations follow a steady 174 BPM. A one-shot's wipe leaves the next section
// behind it, held at its first frame (beat moves keep time, kicks wait until it's on).
export class Show {
  constructor({ sections, drive, colours, brightness = 255, music = null, bpm = 174 }) {
    this.sections = sections.map((s) => normalise(s));
    this.drive = drive; this.palette = palette(colours); this.brightness = brightness;
    this.music = music || ((ms) => steadyMusic(ms, bpm));
  }
  // section start times (ms) and which section plays at t
  where(t) {
    let start = 0;
    for (let k = 0; k < this.sections.length; k++) {
      const s = this.sections[k], last = k === this.sections.length - 1;
      if (last || !s.once) return { k, start };
      if (s.timing !== 'ms') throw new RecipeError(`"${s.name}" is a one-shot timed in beats: only the last section can be (song moments come later).`);
      const len = prepare(s).length;
      if (t < start + len) return { k, start };
      start += len;
    }
    return { k: this.sections.length - 1, start };
  }
  localTime(s, t, start) {
    if (s.timing === 'ms') return Math.round(t - start);
    return this.music(t).beats - this.music(start).beats;
  }
  levels(t) {
    if (t < 0) return levels(this.sections[0], -1, this.ctx());
    const { k, start } = this.where(t);
    const s = this.sections[k], next = this.sections[k + 1];
    const music = this.music(t);
    const ctx = this.ctx(music);
    if (next && s.once) {
      const end = start + prepare(s).length;
      let held = null;
      ctx.next = (i) => (held || (held = levels(next, 0, this.ctx({ ...this.music(end), bar: music.bar, kick: 0 }))))[i];
    }
    return levels(s, this.localTime(s, t, start), ctx);
  }
  ctx(music = { bar: 0, beats: 0, kick: 0, loud: 0 }) { return { drive: this.drive, palette: this.palette, music }; }
  frame(t) { return toPixels(this.levels(t), this.brightness); }
}

export { RecipeError };
