import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePhaseFile, applyPhaseFile, toEngineNames, fromEngineNames, phaseKeys, isPhaseFile, phaseFileName } from '../js/phases.js';
import { Library, MemoryStore, resolveRoutine } from '../js/library.js';
import { packSettings } from '../js/engines.js';
import { demoEngines } from '../js/demo.js';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

const [CORE, PULSE] = demoEngines();

test('a phase file holds only that phase\'s settings, under the engine\'s names', () => {
  const f = makePhaseFile('pulse', 'loadup', ' Fast ', { ...pulse.DEFAULTS, riseMs: 600, bottomLevel: 1 });
  assert.equal(f.name, 'Fast');
  assert.equal(f.settings.riseMs, 600);
  assert.ok(!('bottomLevel' in f.settings), 'standard-phase settings stay out');
  assert.ok(!('red' in f.settings), 'colours stay out');
  assert.deepEqual(Object.keys(f.settings), phaseKeys('pulse', 'loadup'));
  const b = makePhaseFile('pulse', 'beat', 'x', pulse.DEFAULTS);
  assert.ok('kickMin' in b.settings && !('riseMs' in b.settings));
});

test('Core names convert both ways and the result packs into a real settings block', () => {
  const s = structuredClone(core.DEFAULTS);
  s.WHITE_MS = 1500;
  const e = toEngineNames('core', s);
  assert.equal(e.whiteMs, 1500);
  assert.equal(e.cranks.length, 12);
  assert.equal(e.numCranks, 10);
  assert.deepEqual(fromEngineNames('core', core.DEFAULTS, e), s);
  const merged = { ...CORE.defaults, ...makePhaseFile('core', 'loadup', 'slow', s).settings };
  packSettings('SOTA.LED', merged); // throws if anything is out of range
});

test('applying changes only that phase\'s values', () => {
  const f = makePhaseFile('pulse', 'standard', 'bright', { ...pulse.DEFAULTS, middleLevel: 120 });
  const out = applyPhaseFile('pulse', { ...pulse.DEFAULTS, riseMs: 999 }, f);
  assert.equal(out.middleLevel, 120);
  assert.equal(out.riseMs, 999);
  assert.throws(() => applyPhaseFile('core', core.DEFAULTS, f), /not a Core phase file/);
});

test('bad input is refused', () => {
  assert.throws(() => makePhaseFile('pulse', 'loadup', '  ', pulse.DEFAULTS), /name/);
  assert.throws(() => makePhaseFile('pulse', 'loadup', 'a@b', pulse.DEFAULTS), /@/);
  assert.throws(() => makePhaseFile('pulse', 'recognition', 'x', pulse.DEFAULTS), /no settings yet/);
  assert.throws(() => makePhaseFile('pulse', 'nope', 'x', pulse.DEFAULTS), /Unknown phase/);
  assert.ok(!isPhaseFile({ type: 'phase', phase: 'loadup', name: 'x', version: 0, settings: {} }));
});

test('saving the same name makes a new version and keeps the old one', async () => {
  const lib = new Library(new MemoryStore());
  const a = await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 600 }));
  const b = await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 700 }));
  await lib.savePhaseFile(makePhaseFile('core', 'loadup', 'Fast', core.DEFAULTS)); // other board: own count
  await lib.savePhaseFile(makePhaseFile('pulse', 'standard', 'Fast', pulse.DEFAULTS)); // other phase: own count
  assert.deepEqual([a.version, b.version], [1, 2]);
  assert.notEqual(phaseFileName(a), phaseFileName(b));
  const files = await lib.phaseFiles('pulse', 'loadup');
  assert.deepEqual(files.map((p) => [p.version, p.settings.riseMs]), [[1, 600], [2, 700]]);
  assert.equal((await lib.phaseFiles('core')).length, 1);
  assert.equal((await lib.phaseFiles()).length, 4);
});

test('a routine picks phase files by name, latest or pinned, and by board', async () => {
  const lib = new Library(new MemoryStore());
  await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 600 }));
  await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 700 }));
  await lib.savePhaseFile(makePhaseFile('core', 'loadup', 'Fast', core.DEFAULTS));
  await lib.savePhaseFile(makePhaseFile('pulse', 'beat', 'Tight', { ...pulse.DEFAULTS, kickMin: 50 }));
  const routine = { name: 'r', family: 'pulse', phases: { loadup: 'Fast', beat: 'Tight' } };
  const s = await resolveRoutine(lib, routine, PULSE.defaults);
  assert.equal(s.riseMs, 700);
  assert.equal(s.kickMin, 50);
  assert.equal(s.bottomLevel, PULSE.defaults.bottomLevel, 'phases the routine skips keep the engine\'s look');
  assert.equal((await resolveRoutine(lib, { ...routine, phases: { loadup: 'Fast@1' } }, PULSE.defaults)).riseMs, 600);
  packSettings('SOTA.PLS', s);
});
