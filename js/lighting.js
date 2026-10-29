// The drive says what lighting it has (roadmap task 7). pulsetest 1.5 and coretest 1.5 send a
// 2-byte lighting fingerprint with their ID (docs/STATION-PROTOCOL.md):
//   Pulse: the trailer's app CRC, CRC-16 of the routine with its settings page (engine 2: the
//          settings page holds the show's CRC, so the animations and song moments count too)
//   Core:  CRC-16 of the 98 settings bytes in use, from the layout byte on
// checkLighting works out the fingerprint of what the register says and, when the drive says
// something else, of every other lighting the library could have put on it.
//
// whatItPlays names what a Pulse engine 2 plays (its show: js/show.js) by contents, not by name:
// each recipe's bytes against the library's animations and today's looks, each song moment's
// print against the library's song moments.

import { PulseImage, packSettings } from './engines.js';
import { crc16 } from './crc.js';
import { resolveRoutine } from './library.js';
import { COLOUR_KEYS, isPalette } from './palettes.js';
import { unpackShow, demoShow, SHOW_ANIMS } from './show.js';
import { pack } from './player.js';
import * as A from './animations.js';

export const NO_ROUTINE = 0xffff;   // a Pulse whose last update was cut off (its trailer is blank)
export const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// The fingerprint a drive on this engine with these settings sends. null: an engine that doesn't send one.
export function fingerprintOf(engine, settings) {
  if (engine.kind === 'pulsetest') return crc16(new PulseImage(engine.app, engine.version, settings, engine.show).app);
  if (engine.kind === 'coretest') return crc16(packSettings('SOTA.LED', settings).subarray(8));
  return null;
}

const lightingName = (routine) => routine || 'Engine defaults';
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function withColours(family, settings, palette) {
  const out = { ...settings };
  for (const k of COLOUR_KEYS[family]) out[k.toLowerCase()] = [...palette.colours[k]];
  return out;
}

// drive: the register's record. fingerprint: what the drive sent. lib: { engines (every engine
// file for the drive's board: the library's, plus the demo ones on the simulated station),
// routines ([{ data }], as Library.routines()), palettes, library (for the routines' phase files) }.
// Returns { status, name, engine, settings, routine, said } where status is
//   'match'      the drive has what the register says
//   'corrected'  it has something else the library knows: name, engine, settings and routine say what
//   'unfinished' a Pulse whose last update was cut off (fingerprint FFFF)
//   'unknown'    nothing the library knows
// and said is the register's lighting (for "not glacier"). checked: false when the register's own
// engine isn't in the library, so its fingerprint couldn't be worked out.
export async function checkLighting(drive, fingerprint, { engines = [], routines = [], palettes = [], library = null } = {}) {
  const family = drive.family, kind = family === 'core' ? 'coretest' : 'pulsetest';
  const mine = engines.filter((e) => e.kind === kind);
  const reg = drive.engine ? mine.find((e) => e.fileName === drive.engine.file) || mine.find((e) => e.label === drive.engine.label) || null : null;
  const said = lightingName(drive.routine);
  const base = { said, fingerprint, checked: !!reg || family === 'core' };
  const fits = (engine, settings) => {
    try { return fingerprintOf(engine, settings) === fingerprint; } catch { return false; }
  };

  // what the register says (a Core's fingerprint is its settings alone, so no engine file is needed)
  if (drive.settings && (reg ? fits(reg, drive.settings) : family === 'core' && coreFits(drive.settings, fingerprint))) {
    return { ...base, status: 'match', name: said, engine: reg, settings: drive.settings, routine: drive.routine ?? null };
  }
  if (family === 'pulse' && fingerprint === NO_ROUTINE) return { ...base, status: 'unfinished', name: null, engine: null };

  // everything else the library could have put on it: the register's engine first
  const order = reg ? [reg, ...mine.filter((e) => e !== reg)] : mine;
  const sets = palettes.filter((p) => isPalette(p) && p.family === family);
  const tries = [];
  if (family === 'core' && drive.flashedSettings) tries.push({ settings: drive.flashedSettings, routine: drive.flashedRoutine ?? null, engine: reg || order[0] || null });
  for (const engine of order) {
    tries.push({ engine, settings: engine.defaults, routine: null });
    for (const r of routines.filter((x) => x.data && x.data.family === family)) {
      tries.push({ engine, routine: r.data.name, make: () => resolveRoutine(library, r.data, engine.defaults) });
    }
    for (const p of sets) {
      if (drive.settings && engine === reg) tries.push({ engine, routine: `${said} with the ${p.name} colours`, settings: withColours(family, drive.settings, p) });
      tries.push({ engine, routine: `Engine defaults with the ${p.name} colours`, settings: withColours(family, engine.defaults, p) });
    }
  }
  for (const t of tries) {
    let settings = t.settings;
    if (t.make) { try { settings = await t.make(); } catch { continue; } }
    if (!settings) continue;
    const ok = t.engine ? fits(t.engine, settings) : coreFits(settings, fingerprint);
    if (ok) return { ...base, status: 'corrected', name: lightingName(t.routine), engine: t.engine, settings, routine: t.routine };
  }
  return { ...base, status: 'unknown', name: null, engine: null };
}

function coreFits(settings, fingerprint) {
  try { return crc16(packSettings('SOTA.LED', settings).subarray(8)) === fingerprint; } catch { return false; }
}

// The register put right after a 'corrected' check: the drive record changed in place, and the
// line for the Log and the drive's history ("Register corrected: the drive has engine defaults, not glacier").
export function correctRegister(drive, check) {
  const before = drive.engine;
  const engineChanged = !!check.engine && !!before && before.file !== check.engine.fileName;
  const on = (label) => (engineChanged ? ` on ${label}` : '');
  const line = `Register corrected: the drive has ${lower(check.name)}${on(check.engine && check.engine.label)}, not ${lower(check.said)}${on(before && before.label)}`;
  drive.settings = check.settings;
  drive.routine = check.routine ?? null;
  if (check.engine) drive.engine = { label: check.engine.label, file: check.engine.fileName, kind: check.engine.kind };
  if (drive.family === 'core') {
    delete drive.flashedSettings;   // a fingerprint can't tell which copy it came from: start again from what's on it
    delete drive.flashedRoutine;
  }
  return line;
}

// The card's Lighting line.
export function lightingText(check) {
  if (check.status === 'match') return `${check.name} (checked with the drive)`;
  if (check.status === 'corrected') return `${check.name} (checked with the drive; the register said ${lower(check.said)})`;
  if (check.status === 'unfinished') return 'None: its last update was cut off. Send the whole engine again.';
  if (!check.checked) return `Not what the library knows (fingerprint ${hex4(check.fingerprint)}): the register's engine file isn't in the engines folder, so it couldn't be checked. Add that file, or send settings to set it.`;
  return 'Not what the register says. Send settings to set it.';
}

// ---------------------------------------------------------------- what an engine plays
export const SLOT_NAMES = { startup: 'Start-up', ambient: 'Ambient', plugin: 'Plug-in', heartbeat: 'Heartbeat' };
const key = (recipe) => { try { return Array.from(pack({ ...recipe, board: 'pulse' })).join(','); } catch { return null; } };

// Today's looks and the examples, which an engine can have without them being in the library.
function builtIns() {
  return [A.pulseStartup(), A.pulseAmbient(), A.pluginPulse(), A.heartbeat(), A.dropExample(), demoShow().startup];
}

// engine: one from readEngine. lib: { animations (Library.animations('pulse')), moments
// (Library.moments()) }. Returns null for an engine without a show (Core, Pulse engine 1, Beat), else
// { slots: [{ slot, label, name (null: not in the library), bytes }], moments: [{ name, song,
// animation (its name, or null), says (the animation the moment file names), delayMs, repeat }] }.
export function whatItPlays(engine, { animations = [], moments = [] } = {}) {
  if (!engine || engine.kind !== 'pulsetest' || engine.layout !== 2 || !engine.show) return null;
  let show;
  try { show = unpackShow(engine.show); } catch { return null; }
  const named = new Map();
  for (const a of [...animations, ...builtIns()]) {   // the library's own name wins
    const k = key(a);
    if (k && !named.has(k)) named.set(k, a.name);
  }
  const nameOf = (r) => named.get(key(r)) ?? null;
  const prints = new Map(moments.filter((m) => m && m.print).map((m) => [String(m.print).toLowerCase(), m]));
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return {
    slots: SHOW_ANIMS.filter((k) => show[k]).map((k) => ({ slot: k, label: SLOT_NAMES[k], name: nameOf(show[k]), bytes: pack(show[k]).length })),
    moments: show.moments.map((m) => {
      const file = prints.get(hex(m.print)) || null;
      return { name: file ? file.name : null, song: file ? file.song : null, animation: nameOf(m.animation), says: file ? file.animation : null, delayMs: m.delayMs, repeat: m.repeat };
    }),
  };
}

// Plain lines for the card and the Flash Station tab.
export function playsText(p) {
  const anims = p.slots.map((s) => `${s.label}: ${s.name || `one not in the library (${s.bytes} bytes)`}`).join(' · ');
  const moments = p.moments.length
    ? p.moments.map((m) => {
        const what = m.name || 'a song moment not in the library';
        const plays = m.animation || (m.says ? `a different "${m.says}" from the one in the library` : 'an animation not in the library');
        return `${what}, plays ${plays}${m.repeat === 'first' ? ' (first time only)' : ''}`;
      }).join(' · ')
    : 'None';
  return { anims, moments };
}
