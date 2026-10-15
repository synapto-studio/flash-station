// Phase files and routines (the logic; the screen is in routines-tab.js).
//
//   phase file  one phase's settings, saved with a name and a version number
//               { type:'phase', phase, family, tag, name, version, note, settings }
//   routine     picks one phase file per phase, plus a few shared settings
//               { type:'routine', name, family, tag, phases:{loadup:'name@2',...}, shared:{} }
//
// Files are never overwritten: changing a phase file saves the next version beside it, so
// an old routine pinned to "name@1" keeps working.

import { LAYOUTS, packSettings } from './engines.js';

export const PHASES = [
  ['loadup', 'Load-up'],
  ['standard', 'Standard'],
  ['beat', 'Beat'],
  ['recognition', 'Recognition'],
];
export const PHASE_LABEL = Object.fromEntries(PHASES);
// 'shared' fields (brightness, colours) live in the routine itself, not in a phase file.

const FAMILY_OF_TAG = { 'SOTA.LED': 'core', 'SOTA.PLS': 'pulse', 'SOTA.MIC': 'pulse' };
const NAME_OK = /^[a-z0-9][a-z0-9_-]*$/i;

export function checkName(name) {
  if (!NAME_OK.test(name || '')) throw new Error('Names use letters, numbers, - and _ only, with no spaces (e.g. loadup_slow).');
  return name;
}

// [name, type, phase, label] for every setting a phase file may hold on this engine.
export function phaseFields(tag, phase) {
  if (!LAYOUTS[tag]) throw new Error(`Unknown settings block ${tag}.`);
  return LAYOUTS[tag].filter((f) => f[2] === phase);
}
// Phases an engine has settings for (recognition has none yet: it needs station-hello firmware).
export const phasesFor = (tag) => PHASES.filter(([p]) => phaseFields(tag, p).length).map(([p]) => p);
export const sharedFields = (tag) => phaseFields(tag, 'shared');

// Keep only valid fields, and prove the values fit by packing them into the engine's block.
function cleanSettings(tag, phase, settings, defaults) {
  const allowed = new Set(phaseFields(tag, phase).map((f) => f[0]));
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (!allowed.has(k)) throw new Error(`"${k}" doesn't belong to the ${PHASE_LABEL[phase] || phase} phase of ${tag}.`);
    out[k] = v;
  }
  if (defaults) packSettings(tag, { ...defaults, ...out }); // throws "riseMs must be a whole number 0–65535"
  return out;
}

export function makePhaseFile({ tag, phase, name, version = 1, note = '', settings }, defaults = null) {
  if (!PHASE_LABEL[phase]) throw new Error(`Unknown phase "${phase}".`);
  checkName(name);
  return {
    type: 'phase', phase, family: FAMILY_OF_TAG[tag], tag, name, version, note,
    settings: cleanSettings(tag, phase, settings, defaults),
  };
}

export function makeRoutine({ tag, name, phases = {}, shared = {}, note = '' }, defaults = null) {
  checkName(name);
  if (!FAMILY_OF_TAG[tag]) throw new Error(`Unknown settings block ${tag}.`);
  const own = new Set(sharedFields(tag).map((f) => f[0]));
  for (const k of Object.keys(shared)) if (!own.has(k)) throw new Error(`"${k}" isn't a shared setting of ${tag}.`);
  if (defaults) packSettings(tag, { ...defaults, ...shared });
  const picked = {};
  for (const [p, ref] of Object.entries(phases)) {
    if (!ref) continue;
    if (!PHASE_LABEL[p]) throw new Error(`Unknown phase "${p}".`);
    picked[p] = ref;
  }
  return { type: 'routine', name, family: FAMILY_OF_TAG[tag], tag, note, phases: picked, shared: { ...shared } };
}

// ---------------------------------------------------------------- the library side
export function phaseFileName(name, version) {
  return `${name}_v${version}.json`;
}

// All phase files for this engine's settings block, newest first within a name.
export async function listPhaseFiles(library, tag, phase = null) {
  return (await library.phases())
    .map((p) => p.data)
    .filter((d) => d && d.type === 'phase' && (!tag || !d.tag || d.tag === tag) && (!phase || d.phase === phase))
    .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
}

// Saves as version 1 of a new name, or the next version of an existing one. Returns the file.
export async function savePhaseFile(library, { tag, phase, name, note, settings }, defaults = null) {
  checkName(name);
  const same = (await library.phases()).map((p) => p.data).filter((d) => d.name === name);
  if (same.some((d) => d.phase !== phase || (d.tag && d.tag !== tag))) {
    throw new Error(`"${name}" is already a phase file for something else. Pick another name.`);
  }
  const version = same.reduce((m, d) => Math.max(m, d.version || 0), 0) + 1;
  const file = makePhaseFile({ tag, phase, name, version, note, settings }, defaults);
  await library.writeJson('phases', phaseFileName(name, version), file);
  return file;
}

// Routines are plain named files you can edit; saving the same name replaces it.
export async function saveRoutine(library, spec, defaults = null) {
  const routine = makeRoutine(spec, defaults);
  for (const [phase, ref] of Object.entries(routine.phases)) await findPhaseFile(library, ref, phase, routine.tag, routine.name);
  await library.writeJson('routines', `${routine.name}.json`, routine);
  return routine;
}

export async function findPhaseFile(library, ref, phase, tag, who = 'Routine') {
  const [name, version] = String(ref).split('@');
  const matches = (await listPhaseFiles(library, tag, phase)).filter((d) => d.name === name);
  const pick = version ? matches.find((d) => String(d.version) === version) : matches[0];
  if (!pick) throw new Error(`${who}: phase file ${ref} (${PHASE_LABEL[phase] || phase}) isn't in the library.`);
  return pick;
}

// A routine laid over the engine's own settings. Phase files fill their phase, the routine's
// shared settings win last. Packs the result so a bad value fails here, not on the drive.
export async function applyRoutine(library, routine, engine) {
  if (routine.tag && routine.tag !== engine.tag) {
    throw new Error(`Routine ${routine.name} is for ${routine.family === 'core' ? 'Core' : 'Pulse'} engines (${routine.tag}), not ${engine.label}.`);
  }
  const settings = structuredClone(engine.defaults);
  for (const [phase, ref] of Object.entries(routine.phases || {})) {
    if (!ref) continue;
    Object.assign(settings, (await findPhaseFile(library, ref, phase, engine.tag, `Routine ${routine.name}`)).settings);
  }
  Object.assign(settings, routine.shared || {});
  packSettings(engine.tag, settings);
  return settings;
}

// What a routine changes from the engine defaults, for the list view.
export function describeChanges(settings, defaults) {
  return Object.keys(settings).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(defaults[k]));
}
