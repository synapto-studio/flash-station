import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoutine, isRoutine, routineFileName } from '../js/routines.js';
import { makePhaseFile } from '../js/phases.js';
import { makePalette } from '../js/palettes.js';
import { Library, MemoryStore, resolveRoutine } from '../js/library.js';
import { packSettings } from '../js/engines.js';
import { demoEngines } from '../js/demo.js';

const [, PULSE] = demoEngines();
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

test('a routine keeps only the phases picked and copies the colours in', () => {
  const pal = makePalette('pulse', 'Club', { ...pulse.DEFAULTS, red: [9, 8, 7] });
  const r = makeRoutine('pulse', ' Night ', { phases: { loadup: 'Fast', standard: '', beat: 'Tight@2' }, palette: pal, brightness: 150 });
  assert.deepEqual(r.phases, { loadup: 'Fast', beat: 'Tight@2' });
  assert.deepEqual(r.shared.red, [9, 8, 7]);
  assert.equal(r.shared.brightness, 150);
  assert.equal(r.name, 'Night');
  assert.ok(isRoutine(r));
  assert.equal(routineFileName(r), 'pulse-night.json');
});

test('refused: no name, nothing picked, bad brightness, colour set for the other board', () => {
  assert.throws(() => makeRoutine('pulse', ' ', { brightness: 5 }), /name/);
  assert.throws(() => makeRoutine('pulse', 'x', {}), /at least one/);
  assert.throws(() => makeRoutine('pulse', 'x', { brightness: 0 }), /1 to 255/);
  const coreSet = makePalette('core', 'Warm', core.DEFAULTS);
  assert.throws(() => makeRoutine('pulse', 'x', { palette: coreSet }), /not a Pulse colour set/);
});

test('a saved routine resolves to the phase files, colours and brightness, and packs for the engine', async () => {
  const lib = new Library(new MemoryStore());
  await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 600 }));
  await lib.savePhaseFile(makePhaseFile('pulse', 'loadup', 'Fast', { ...pulse.DEFAULTS, riseMs: 700 }));
  await lib.savePhaseFile(makePhaseFile('pulse', 'beat', 'Tight', { ...pulse.DEFAULTS, kickMin: 50 }));
  const pal = makePalette('pulse', 'Club', { ...pulse.DEFAULTS, orange: [200, 90, 0] });
  await lib.saveRoutine(makeRoutine('pulse', 'Night', { phases: { loadup: 'Fast@1', beat: 'Tight' }, palette: pal, brightness: 120 }));
  await lib.saveRoutine(makeRoutine('core', 'Warm', { brightness: 100 }));
  assert.equal((await lib.routines('pulse')).length, 1);
  const saved = (await lib.routines('pulse'))[0].data;
  const s = await resolveRoutine(lib, saved, PULSE.defaults);
  assert.equal(s.riseMs, 600, 'pinned version');
  assert.equal(s.kickMin, 50);
  assert.deepEqual(s.orange, [200, 90, 0]);
  assert.equal(s.brightness, 120);
  packSettings('SOTA.PLS', s);
  // same name replaces
  await lib.saveRoutine(makeRoutine('pulse', 'Night', { brightness: 90 }));
  const again = await lib.routines('pulse');
  assert.equal(again.length, 1);
  assert.equal(again[0].data.shared.brightness, 90);
});
