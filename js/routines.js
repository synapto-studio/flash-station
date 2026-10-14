// Routine editor logic (no screen code, so it can be tested): phase files with versions,
// colour sets (palettes), routines, and drive profiles. Everything is saved as small .json
// files in the library folder.
//
//   phases/    one phase of the show for one engine: { name, phase, tag, version, settings }
//   palettes/  a saved colour set: { name, tag, colours: { red: [r,g,b], ... } }
//   routines/  picks one phase file per phase, a palette and some shared values
//   casings/   a drive profile: LED count, groups, each LED's place from plug to logo

import { LAYOUTS, packSettings } from './engines.js';

export const PHASES = [
  { key: 'loadup', label: 'Load-up', note: 'What plays when the drive is plugged in.' },
  { key: 'standard', label: 'Standard', note: 'The loop that plays while the drive is on.' },
  { key: 'beat', label: 'Beat', note: 'How it reacts to music.' },
  { key: 'recognition', label: 'Recognition', note: 'The Flash Station hello. No settings yet: it arrives with pulsetest 1.1 and coretest 1.3.' },
];

// The three settings layouts the app knows, by tag.
export const ENGINES = {
  'SOTA.PLS': { family: 'pulse', name: 'pulsetest', short: 'pls' },
  'SOTA.LED': { family: 'core', name: 'coretest', short: 'led' },
  'SOTA.MIC': { family: 'pulse', name: 'Beat', short: 'mic' },
};

export const LED_COUNT = { pulse: 8, core: 6 };

export const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const isRgbName = (tag, name) => LAYOUTS[tag].some(([n, t]) => n === name && t === 'rgb');

// Fields of a layout that belong to one phase: [name, type, phase, label].
export function phaseFields(tag, phase) {
  return LAYOUTS[tag].filter((f) => f[2] === phase);
}

export function colourFields(tag) {
  return LAYOUTS[tag].filter((f) => f[1] === 'rgb');
}

// Throws a plain message if the values wouldn't fit in the engine's settings block.
export function checkSettings(tag, defaults, partial) {
  packSettings(tag, { ...defaults, ...partial });
}

function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

function cleanName(name, what) {
  const n = String(name || '').trim();
  need(n, `Give the ${what} a name first.`);
  need(!n.includes('@'), `The ${what} name can't contain "@" (it separates the name from the version).`);
  need(slug(n), `The ${what} name needs at least one letter or number.`);
  return n;
}

// ---------------------------------------------------------------- phase files
export async function savePhase(library, { name, phase, tag, defaults, settings }) {
  const n = cleanName(name, 'phase file');
  const info = ENGINES[tag];
  need(info, `Unknown settings layout ${tag}.`);
  const fields = phaseFields(tag, phase);
  need(fields.length, `${tag} has no ${phase} settings.`);
  const picked = {};
  for (const [f] of fields) {
    need(settings[f] !== undefined, `Missing value for ${f}.`);
    picked[f] = structuredClone(settings[f]);
  }
  checkSettings(tag, defaults, picked);
  const existing = (await library.phases()).filter((p) => p.data.name === n && p.data.phase === phase && p.data.tag === tag);
  const version = existing.reduce((m, p) => Math.max(m, p.data.version || 0), 0) + 1;
  const data = { name: n, phase, tag, family: info.family, version, settings: picked, saved: new Date().toISOString() };
  await library.writeJson('phases', `${phase}_${slug(n)}_${info.short}_v${version}.json`, data);
  return data;
}

// Names of phase files for one phase and engine, newest version first.
export async function phaseFiles(library, phase, tag) {
  const all = (await library.phases()).map((p) => p.data).filter((d) => d.phase === phase && d.tag === tag);
  return all.sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
}

// ---------------------------------------------------------------- palettes
export async function savePalette(library, { name, tag, defaults, colours }) {
  const n = cleanName(name, 'colour set');
  need(ENGINES[tag], `Unknown settings layout ${tag}.`);
  const clean = {};
  for (const [k, v] of Object.entries(colours)) {
    need(isRgbName(tag, k), `${k} isn't a colour in ${tag}.`);
    clean[k] = [...v];
  }
  need(Object.keys(clean).length, 'A colour set needs at least one colour.');
  checkSettings(tag, defaults, clean);
  const data = { name: n, tag, family: ENGINES[tag].family, colours: clean, saved: new Date().toISOString() };
  await library.writeJson('palettes', `${slug(n)}_${ENGINES[tag].short}.json`, data);
  return data;
}

// ---------------------------------------------------------------- routines
// phases: { loadup: "name" | "name@2" | null, ... }; palette: a colour set name or null;
// shared: values that override everything (brightness, a colour...).
export async function saveRoutine(library, { name, tag, defaults, phases = {}, palette = null, shared = {} }) {
  const n = cleanName(name, 'routine');
  const info = ENGINES[tag];
  need(info, `Unknown settings layout ${tag}.`);
  const record = { name: n, family: info.family, tag, phases: {}, palette: palette || null, shared: structuredClone(shared) };
  for (const { key } of PHASES) if (phases[key]) record.phases[key] = String(phases[key]);
  need(Object.keys(record.phases).length || record.palette || Object.keys(shared).length, 'Pick at least one phase file, a colour set or a shared value.');
  // Resolving it proves every file it names exists and fits the engine.
  const settings = await resolveRoutine(library, record, defaults);
  packSettings(tag, settings);
  await library.writeJson('routines', `${slug(n)}.json`, record);
  return record;
}

// A routine over an engine's defaults: phase files first, then the colour set, then the
// shared values. A missing phase keeps the engine's own look.
export async function resolveRoutine(library, routine, engineDefaults) {
  const settings = structuredClone(engineDefaults);
  const tag = engineDefaults.tag;
  const phases = (await library.phases()).filter((p) => !p.data.tag || p.data.tag === tag);
  for (const [phase, ref] of Object.entries(routine.phases || {})) {
    if (!ref) continue;
    const [name, version] = String(ref).split('@');
    const matches = phases.filter((p) => p.data.name === name && p.data.phase === phase);
    const pick = version ? matches.find((p) => String(p.data.version) === version) : matches.sort((a, b) => (b.data.version || 0) - (a.data.version || 0))[0];
    if (!pick) throw new Error(`Routine ${routine.name}: phase file ${ref} (${phase}) isn't in the library for this engine.`);
    Object.assign(settings, pick.data.settings);
  }
  if (routine.palette) {
    const pal = (await library.palettes()).find((p) => p.name === routine.palette && (!p.tag || p.tag === tag));
    if (!pal) throw new Error(`Routine ${routine.name}: colour set ${routine.palette} isn't in the library for this engine.`);
    Object.assign(settings, pal.colours);
  }
  Object.assign(settings, routine.shared || {});
  settings.tag = engineDefaults.tag;
  settings.layout = engineDefaults.layout;
  return settings;
}

// ---------------------------------------------------------------- drive profiles
// Each LED's place runs 0 (at the plug) to 1 (at the logo). These match the drawing.
export function defaultProfile(family, code = 'SOTA') {
  const pulse = {
    groups: ['bottom', 'middle', 'top'],
    leds: [[1, 'bottom', 0], [2, 'bottom', 0], [7, 'bottom', 0], [8, 'bottom', 0], [3, 'middle', 0.5], [4, 'middle', 0.5], [5, 'top', 1], [6, 'top', 1]],
  };
  const core = { groups: ['outer', 'inner'], leds: [[1, 'outer', 0], [2, 'outer', 0], [3, 'inner', 0.5], [4, 'inner', 0.5], [5, 'outer', 1], [6, 'outer', 1]] };
  const p = family === 'pulse' ? pulse : core;
  return {
    code: String(code).trim().toUpperCase(), family, ledCount: LED_COUNT[family], groups: [...p.groups],
    leds: p.leds.map(([n, group, position]) => ({ n, group, position })).sort((a, b) => a.n - b.n),
  };
}

export function checkProfile(profile) {
  need(/^[A-Z0-9]{1,4}$/.test(profile.code || ''), 'The casing code is 1 to 4 letters or numbers (like SOTA).');
  need(LED_COUNT[profile.family], 'Choose Core or Pulse.');
  need(profile.ledCount === LED_COUNT[profile.family], `${profile.family === 'pulse' ? 'Pulse' : 'Core'} has ${LED_COUNT[profile.family]} LEDs.`);
  need(Array.isArray(profile.groups) && profile.groups.length, 'Add at least one group.');
  need(profile.leds.length === profile.ledCount, `The list needs ${profile.ledCount} LEDs (it has ${profile.leds.length}).`);
  const seen = new Set();
  for (const l of profile.leds) {
    need(Number.isInteger(l.n) && l.n >= 1 && l.n <= profile.ledCount, `LED numbers run 1 to ${profile.ledCount}.`);
    need(!seen.has(l.n), `LED ${l.n} is listed twice.`);
    seen.add(l.n);
    need(profile.groups.includes(l.group), `LED ${l.n}: group "${l.group}" isn't in the group list.`);
    need(typeof l.position === 'number' && l.position >= 0 && l.position <= 1, `LED ${l.n}: place must be 0 (plug) to 1 (logo).`);
  }
}

export async function saveProfile(library, profile) {
  const clean = { ...profile, code: String(profile.code || '').trim().toUpperCase() };
  checkProfile(clean);
  await library.writeJson('casings', `${clean.code}.json`, clean);
  return clean;
}
