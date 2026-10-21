// The Animation lab (roadmap R3): reads a recipe pasted from a Claude session, forgiving the
// slips that copying makes and saying plainly what's wrong with anything else; describes it;
// and names and writes its file in the library's animations/ folder. The lab on screen is
// js/lab-tab.js; the recipe format is docs/ANIMATION-FORMAT.md.

import { normalise, pack, length, MOVES, RECIPE_KEYS, RecipeError } from './player.js';
import { isPalette } from './palettes.js';
import { isRoutine } from './routines.js';
import { isPhaseFile } from './phases.js';
import { isProfile } from './profiles.js';

// at: where in the pasted text the problem is ({ line, col, index }), when it's a typing slip.
export class LabError extends Error {
  constructor(message, at = null) { super(message); this.at = at; }
}

// ---------------------------------------------------------------- reading pasted text
// JSON as Claude writes it, forgiving what copying a chat message does: ```json fences, words
// before and after the recipe, // comments, a comma before } or ], setting names without
// quotes, single quotes and curly quotes. Anything else gets its line and a plain fix.
export function parseLoose(text) {
  const src = String(text).replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'");
  let i = 0, end = src.length;
  const fence = /```[a-zA-Z]*[^\n]*\n/.exec(src);
  if (fence) { // the recipe is the first fenced block
    i = fence.index + fence[0].length;
    const close = src.indexOf('```', i);
    if (close >= 0) end = close;
  }
  const brace = src.slice(i, end).search(/[{[]/);
  if (brace < 0) {
    throw new LabError(src.trim() ? 'There\'s no recipe here: a recipe starts with { and ends with }. Copy the whole recipe from the chat.' : 'Paste a recipe first. In a Claude Code session, describe the animation and Claude writes the recipe.');
  }
  i += brace;
  const where = (at) => {
    const before = src.slice(0, at), line = before.split('\n').length;
    return { line, col: at - before.lastIndexOf('\n'), index: at };
  };
  const fail = (msg, at = i) => { const w = where(Math.min(at, src.length)); throw new LabError(`Line ${w.line}: ${msg}`, w); };
  const cutOff = () => fail('the recipe stops part way through, so it looks cut off. Copy the whole recipe, from the first { to the last }.', end);
  const gap = () => {
    for (;;) {
      const c = src[i];
      if (i >= end) return;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ') i++;
      else if (c === '/' && src[i + 1] === '/') { while (i < end && src[i] !== '\n') i++; }
      else if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0 || e >= end) fail('a comment starts with /* but never ends with */.'); i = e + 2; }
      else return;
    }
  };
  const word = () => { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, Math.min(end, i + 64))); return m ? m[0] : ''; };
  const what = (c) => {
    if (c === '"' || c === "'") { const e = src.indexOf(c, i + 1), s = e > i && e - i < 40 ? src.slice(i + 1, e) : ''; return s && !s.includes('\n') ? `"${s}"` : 'the next value'; }
    return /[A-Za-z_]/.test(c) ? `"${word()}"` : `"${c}"`;
  };

  function string() {
    const q = src[i], start = i++;
    let out = '';
    while (i < end && src[i] !== q) {
      const c = src[i];
      if (c === '\n') fail(`a quote (${q}) opened here is never closed.`, start);
      if (c === '\\') {
        const e = src[i + 1], map = { '"': '"', "'": "'", '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (!(e in map)) fail(`"\\${e || ''}" isn't something a recipe can hold. Remove the backslash.`);
        out += map[e]; i += 2; continue;
      }
      out += c; i++;
    }
    if (i >= end) fail(`a quote (${q}) opened here is never closed.`, start);
    i++;
    return out;
  }
  function number() {
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i, end));
    if (!m) fail(`"${src[i]}" should be followed by a number.`);
    i += m[0].length;
    if (/[A-Za-z%]/.test(src[i] || '')) fail(`"${m[0]}${word() || src[i]}" isn't a number. Write just the number (times are in ms, or beats when the recipe's timing is "beats").`);
    return Number(m[0]);
  }
  function value() {
    gap();
    if (i >= end) cutOff();
    const c = src[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'") return string();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return number();
    const w = word();
    if (w === 'true' || w === 'false' || w === 'null') { i += w.length; return w === 'true' ? true : w === 'false' ? false : null; }
    if (w) fail(`"${w}" isn't a number, true or false. If it's a word, put it in double quotes: "${w}".`);
    if (c === '}' || c === ']') fail(`a value is missing before this ${c}.`);
    if (c === ',') fail('there are two commas in a row, or a value is missing before this comma.');
    fail(`"${c}" doesn't belong here.`);
  }
  function object() {
    const open = i++, o = {};
    for (;;) {
      gap();
      if (i >= end) fail('this { is never closed with a }. The recipe may be cut off.', open);
      if (src[i] === '}') { i++; return o; }
      let key;
      const at = i;
      if (src[i] === '"' || src[i] === "'") key = string();
      else if ((key = word())) i += key.length;
      else fail(`expected a setting name in double quotes, like "move", but found ${what(src[i])}.`);
      if (Object.prototype.hasOwnProperty.call(o, key)) fail(`"${key}" is given twice in the same { }. Keep one.`, at);
      gap();
      if (src[i] !== ':') fail(i >= end ? 'the recipe stops part way through. Copy the whole recipe.' : `a colon (:) is missing after "${key}".`);
      i++;
      o[key] = value();
      gap();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return o; }
      if (i >= end) fail('this { is never closed with a }. The recipe may be cut off.', open);
      if (src[i] === ']') fail('this ] closes a list, but a { ... } is still open. Check the brackets.');
      fail(`a comma is missing before ${what(src[i])}.`);
    }
  }
  function array() {
    const open = i++, a = [];
    for (;;) {
      gap();
      if (i >= end) fail('this [ is never closed with a ]. The recipe may be cut off.', open);
      if (src[i] === ']') { i++; return a; }
      a.push(value());
      gap();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return a; }
      if (i >= end) fail('this [ is never closed with a ]. The recipe may be cut off.', open);
      if (src[i] === '}') fail('this } closes a { ... }, but a [ ... ] list is still open. Check the brackets.');
      fail(`a comma is missing before ${what(src[i])}.`);
    }
  }

  const out = value();
  gap();
  if (i < end) {
    if (src[i] === '}' || src[i] === ']') fail(`there's an extra ${src[i]} after the end of the recipe. Remove it, or check the brackets above it.`);
    if (src[i] === '{') fail('a second recipe starts here. Paste one recipe at a time.');
    // anything else after the recipe is words from the chat: ignore them
  }
  return out;
}

// ---------------------------------------------------------------- a recipe from pasted text
// What else people might paste by mistake, so the error can say what it is.
function notARecipe(x) {
  if (Array.isArray(x)) return x.length && x[0] && (x[0].move || x[0].layers) ? 'This is a list of layers. Wrap it as a recipe: { "type": "animation", "name": "...", "layers": [ ...the list... ] }.' : 'This is a list. A recipe starts with { and has "layers" or "steps".';
  if (!x || typeof x !== 'object') return 'This is a single value. A recipe starts with { and has "layers" or "steps".';
  if (isPalette(x)) return `This is a colour set ("${x.name}"), not an animation. Pick colour sets in the Colours list.`;
  if (isRoutine(x)) return `This is a routine ("${x.name}"), not an animation.`;
  if (isPhaseFile(x)) return `This is a phase file ("${x.name}"), not an animation.`;
  if (isProfile(x)) return `This is a drive profile ("${x.name}"), not an animation.`;
  if (x.move && !x.layers && !x.steps) return 'This is one layer. Wrap it as a recipe: { "type": "animation", "name": "...", "layers": [ ...the layer... ] }.';
  return null;
}

// Times in a recipe, for the "is this ms or beats?" check.
function timesOf(anim) {
  const out = [];
  for (const l of anim.layers) {
    for (const [name, type] of MOVES[l.move].params) if (type === 'time' && l[name]) out.push([name, l[name]]);
    if (l.for) out.push(['for', l.for]);
  }
  return out;
}

// Things that work but are probably not what was meant.
export function warningsFor(anim) {
  const w = [];
  if (anim.timing === 'ms') {
    const tiny = timesOf(anim).filter(([, v]) => v <= 20);
    if (tiny.length) w.push(`Some times are 20 ms or less (${tiny.slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')}). Times are in ms unless the recipe says "timing": "beats".`);
  } else {
    const huge = timesOf(anim).filter(([, v]) => v > 256);
    if (huge.length) w.push(`Some times are over 64 bars (${huge.slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ')}). In a beat-timed recipe, times are in beats (4 to a bar), not ms.`);
    if (anim.board === 'core') w.push('Core has no microphone, so it can\'t follow the music. Beat timing is for Pulse.');
  }
  return w;
}

// Pasted text -> { recipe (as written, with "type" first), anim (the player's form), bytes,
// warnings }. Throws a LabError (or RecipeError) with a plain message.
export function readRecipe(text) {
  const x = parseLoose(text);
  const not = notARecipe(x);
  if (not) throw new LabError(not);
  const anim = normalise(x);
  const recipe = { type: 'animation', ...x };
  return { recipe, anim, bytes: pack(x).length, warnings: warningsFor(anim) };
}

// ---------------------------------------------------------------- describing it
const BOARD = { core: 'Core', pulse: 'Pulse', any: 'Any board' };
const num = (v) => String(+v.toFixed(2));
export function span(anim, v) {
  if (anim.timing === 'ms') return v >= 1000 ? `${num(v / 1000)} s` : `${num(v)} ms`;
  if (v >= 4 && v % 4 === 0) return `${v / 4} bar${v === 4 ? '' : 's'}`;
  return `${num(v)} beat${v === 1 ? '' : 's'}`;
}
export function describe(anim, bytes) {
  const len = length(anim), n = anim.layers.length;
  const how = anim.once ? `plays once, ${span(anim, len)}` : len === null ? 'keeps going' : `loops every ${span(anim, len)}`;
  return `${BOARD[anim.board]}, ${anim.timing === 'beats' ? 'follows the beat' : 'timed in ms'}, ${how}. ${n} layer${n === 1 ? '' : 's'}, ${bytes} bytes on the drive.`;
}

// ---------------------------------------------------------------- the lab's timeline
// How long the lab's timeline is, in beats or ms (the recipe's own units): a one-shot and a
// short dark tail; a loop repeated to fill at least 8 s or 8 bars.
const TAIL = { ms: 1500, beats: 4 };
const MIN = { ms: 8000, beats: 32 };
export const MAX_TIMELINE_MS = 60000;
export function naturalCycle(anim) {
  const len = length(anim);
  if (len !== null) return len;
  let c = 0;
  for (const l of anim.layers) if (l.every) c = Math.max(c, l.every * (l.colours ? l.colours.length : 1) + (l.lag ? Math.abs(l.lag) : 0));
  return c || MIN[anim.timing];
}
export function timelineLength(anim) {
  if (anim.once) return length(anim) + TAIL[anim.timing];
  const c = naturalCycle(anim);
  return c * Math.max(1, Math.ceil(MIN[anim.timing] / c));
}

// ---------------------------------------------------------------- the animations/ folder
export function isAnimation(x) {
  if (!x || x.type !== 'animation' || typeof x.name !== 'string') return false;
  try { normalise(x); return true; } catch { return false; }
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export function animationFileName(recipe) {
  const s = slug(recipe.name);
  if (!s) throw new LabError('Give the animation a name.');
  return `${recipe.board || 'any'}-${s}.json`;
}

// The recipe as it's saved: named, its board, timing and once written out, then its notes,
// layers and steps as they were written (steps stay steps).
export function makeAnimation(recipe, name = recipe.name) {
  const clean = String(name == null ? '' : name).trim();
  if (!clean) throw new LabError('Give the animation a name.');
  const anim = normalise({ ...recipe, name: clean });
  const out = { type: 'animation', name: clean, board: anim.board, timing: anim.timing, once: anim.once };
  if (recipe.notes !== undefined) out.notes = recipe.notes;
  if (recipe.layers !== undefined) out.layers = recipe.layers;
  if (recipe.steps !== undefined) out.steps = recipe.steps;
  return out;
}

// A recipe as text: one line per layer, so it reads like Claude wrote it and pastes straight
// back into a session or the lab.
const inline = (v) => (Array.isArray(v) ? `[${v.map(inline).join(', ')}]`
  : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
  : JSON.stringify(v));
export function recipeText(recipe) {
  const head = RECIPE_KEYS.filter((k) => !['notes', 'layers', 'steps'].includes(k) && recipe[k] !== undefined).map((k) => `${JSON.stringify(k)}: ${inline(recipe[k])}`);
  const parts = [`  ${head.join(', ')}`];
  if (recipe.notes !== undefined) parts.push(`  "notes": ${inline(recipe.notes)}`);
  const layers = (ls, pad) => ls.map((l) => `${pad}${inline(l)}`).join(',\n');
  if (recipe.layers !== undefined) parts.push(`  "layers": [\n${layers(recipe.layers, '    ')}\n  ]`);
  if (recipe.steps !== undefined) {
    const steps = recipe.steps.map((s) => {
      const { layers: ls = [], ...rest } = s;
      const own = Object.entries(rest).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ');
      return `    { ${own}${own ? ', ' : ''}"layers": [\n${layers(ls, '      ')}\n    ] }`;
    });
    parts.push(`  "steps": [\n${steps.join(',\n')}\n  ]`);
  }
  return `{\n${parts.join(',\n')}\n}\n`;
}

export { RecipeError };
