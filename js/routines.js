// Routines: a named recipe that picks one phase file for each phase, plus a colour set and the
// overall brightness. Saved in the library's routines/ folder; resolveRoutine (library.js) turns
// one into the settings a board or drive gets.
//
//   { type: 'routine', name, family, phases: { loadup: 'Fast rise@2', standard: 'Calm', beat: 'Tight' },
//     shared: { brightness, white, red, orange, ... } }
//
// A phase reference is a phase file's name, or "name@version" to pin one version. Without a version
// the newest is used. Colours are copied in from a colour set under the engine's own names.

import { PHASES, slug } from './phases.js';
import { COLOUR_KEYS, isPalette } from './palettes.js';

// Phases a routine can pick a file for (recognition has no settings yet).
export const ROUTINE_PHASES = PHASES.filter((p) => p.id !== 'recognition');

export const phaseRef = (file, pin = false) => (pin ? `${file.name}@${file.version}` : file.name);

// phases: { loadup: ref | '', ... }. Blank phases are left out, so they keep the engine's own look.
export function makeRoutine(family, name, { phases = {}, palette = null, brightness = null } = {}) {
  if (!COLOUR_KEYS[family]) throw new Error(`Unknown board "${family}".`);
  const clean = String(name).trim();
  if (!clean) throw new Error('Give the routine a name.');
  const picked = {};
  for (const p of ROUTINE_PHASES) if (phases[p.id]) picked[p.id] = String(phases[p.id]);
  if (!Object.keys(picked).length && !palette && brightness == null) throw new Error('Pick at least one phase file, a colour set or a brightness.');
  const shared = {};
  if (brightness != null) {
    if (!Number.isInteger(brightness) || brightness < 1 || brightness > 255) throw new Error('Brightness goes from 1 to 255.');
    shared.brightness = brightness;
  }
  if (palette) {
    if (!isPalette(palette) || palette.family !== family) throw new Error(`"${palette.name}" is not a ${family === 'core' ? 'Core' : 'Pulse'} colour set.`);
    for (const k of COLOUR_KEYS[family]) shared[k.toLowerCase()] = [...palette.colours[k]];
  }
  return { type: 'routine', name: clean, family, phases: picked, shared };
}

export function isRoutine(r) {
  return !!r && typeof r.name === 'string' && !!r.name && !!COLOUR_KEYS[r.family] &&
    !!r.phases && typeof r.phases === 'object' && (r.shared === undefined || typeof r.shared === 'object');
}

export const routineFileName = (r) => `${r.family}-${slug(r.name)}.json`;
