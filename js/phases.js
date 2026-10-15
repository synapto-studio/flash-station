// Phase files: the settings for one phase of a drive's lights, saved as a named, versioned file in
// the library's phases/ folder. A routine picks one phase file per phase (see resolveRoutine).
//
//   load-up      what plays at power-on
//   standard     what plays with no music
//   beat         how it reacts to music
//   recognition  the station-hello animation (drive firmware not ready yet, so no settings)
//
// A file holds settings under the engine's own setting names (the layout names in engines.js),
// because that is what a routine resolves and the Flash Station sends. Colours stay out of
// phase files: they live in the shared part of a routine and in saved colour sets.

import { fieldsForPhase } from './engines.js';

export const PHASES = [
  { id: 'loadup', label: 'Load-up' },
  { id: 'standard', label: 'Standard' },
  { id: 'beat', label: 'Beat' },
  { id: 'recognition', label: 'Recognition' },
];
export const phaseLabel = (id) => (PHASES.find((p) => p.id === id) || { label: id }).label;

const TAGS = { core: 'SOTA.LED', pulse: 'SOTA.PLS' };

// The Routines tab previews Core with the reference page's names; engines use layout names.
const CORE_NAMES = {
  STARTUP_DIM_LEVEL: 'startupDim', WHITE_MS: 'whiteMs', WHITE_TO_RED_MS: 'whiteToRedMs',
  COLOUR_STEP_MS: 'colourStepMs', BREATHE_MS: 'breatheMs', BREATHE_MIN: 'breatheMin',
  CATCH_MS: 'catchMs', CATCH_FROM: 'catchFrom',
};

// Preview settings -> engine setting names (so they can be saved or sent).
export function toEngineNames(family, s) {
  if (family !== 'core') return { ...s };
  const out = {};
  for (const [from, to] of Object.entries(CORE_NAMES)) out[to] = s[from];
  out.cranks = Array.from({ length: 12 }, (_, i) => (s.CRANKS[i] ? [...s.CRANKS[i]] : [0, 0, 0]));
  out.numCranks = s.CRANKS.length;
  return out;
}

// Engine setting names -> a copy of the preview settings with those values on top.
export function fromEngineNames(family, preview, e) {
  const out = family === 'core' ? structuredClone(preview) : { ...preview };
  if (family !== 'core') {
    for (const k of Object.keys(e)) if (k in out) out[k] = e[k];
    return out;
  }
  for (const [from, to] of Object.entries(CORE_NAMES)) if (to in e) out[from] = e[to];
  if (e.cranks) out.CRANKS = e.cranks.slice(0, e.numCranks ?? 10).map((c) => [...c]);
  return out;
}

// The setting names a phase owns for one board (empty for recognition).
export function phaseKeys(family, phase) {
  const tag = TAGS[family];
  if (!tag) throw new Error(`Unknown board "${family}".`);
  return fieldsForPhase(tag, phase);
}

export function slug(name) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Give the phase file a name.');
  return slug;
}

export function phaseFileName(file) {
  return `${file.family}-${file.phase}-${slug(file.name)}-v${file.version}.json`;
}

// previewSettings are the Routines tab's settings. Version is chosen by the library when saving.
export function makePhaseFile(family, phase, name, previewSettings, version = 1) {
  if (!PHASES.some((p) => p.id === phase)) throw new Error(`Unknown phase "${phase}".`);
  const clean = String(name).trim();
  if (!clean) throw new Error('Give the phase file a name.');
  if (clean.includes('@')) throw new Error('Leave "@" out of the name: routines use it to pick a version.');
  const keys = phaseKeys(family, phase);
  if (!keys.length) throw new Error(`${phaseLabel(phase)} has no settings yet, so there is nothing to save.`);
  const all = toEngineNames(family, previewSettings);
  return { type: 'phase', family, phase, name: clean, version, settings: Object.fromEntries(keys.map((k) => [k, all[k]])) };
}

export function isPhaseFile(p) {
  return !!p && p.type === 'phase' && PHASES.some((x) => x.id === p.phase) && typeof p.name === 'string' && !!p.name &&
    Number.isInteger(p.version) && p.version >= 1 && !!p.settings && typeof p.settings === 'object';
}

// New preview settings with the phase file's values on top; other phases are left alone.
export function applyPhaseFile(family, preview, file) {
  if (!isPhaseFile(file) || (file.family && file.family !== family)) {
    throw new Error(`"${file && file.name}" is not a ${family === 'core' ? 'Core' : 'Pulse'} phase file.`);
  }
  return fromEngineNames(family, preview, file.settings);
}
