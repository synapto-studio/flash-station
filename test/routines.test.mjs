import test from 'node:test';
import assert from 'node:assert/strict';
import { SimChip, SimTransport } from '../js/sim.js';
import { demoEngines } from '../js/demo.js';
import { buildInitImage } from '../js/engines.js';
import { encodeCard } from '../js/idcard.js';
import { checkBoard, initialiseBoard } from '../js/initialise.js';
import { Library, MemoryStore } from '../js/library.js';
import { PHASES, phaseFields, phasesFor, makePhaseFile, savePhaseFile, saveRoutine, listPhaseFiles, applyRoutine, describeChanges } from '../js/routines.js';

const [CORE, PULSE] = demoEngines();

test('phase fields come from the settings layout', () => {
  assert.deepEqual(PHASES.map((p) => p[0]), ['loadup', 'standard', 'beat', 'recognition']);
  assert.ok(phaseFields('SOTA.PLS', 'loadup').some((f) => f[0] === 'riseMs'));
  assert.ok(phasesFor('SOTA.PLS').includes('beat'));
  assert.ok(!phasesFor('SOTA.LED').includes('beat'), 'Core has no beat phase');
  assert.ok(!phasesFor('SOTA.PLS').includes('recognition'), 'recognition waits for station-hello firmware');
});

test('phase files: wrong-phase fields and out-of-range values are refused', () => {
  assert.throws(() => makePhaseFile({ tag: 'SOTA.PLS', phase: 'loadup', name: 'x', settings: { bpmMin: 100 } }), /doesn't belong/);
  assert.throws(() => makePhaseFile({ tag: 'SOTA.PLS', phase: 'loadup', name: 'x', settings: { riseMs: 70000 } }, PULSE.defaults), /riseMs/);
  assert.throws(() => makePhaseFile({ tag: 'SOTA.PLS', phase: 'loadup', name: 'bad name', settings: {} }), /no spaces/);
});

test('saving a phase file again makes the next version and keeps the old one', async () => {
  const lib = new Library(new MemoryStore());
  const a = await savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'loadup', name: 'slow', settings: { riseMs: 2000 } }, PULSE.defaults);
  const b = await savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'loadup', name: 'slow', settings: { riseMs: 2500 } }, PULSE.defaults);
  assert.deepEqual([a.version, b.version], [1, 2]);
  assert.deepEqual((await listPhaseFiles(lib, 'SOTA.PLS', 'loadup')).map((d) => d.version), [2, 1]);
  await assert.rejects(savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'standard', name: 'slow', settings: {} }), /already a phase file/);
});

test('a routine built from phase files initialises a simulated board with those settings', async () => {
  const lib = new Library(new MemoryStore());
  await savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'loadup', name: 'slow', settings: { riseMs: 2000 } }, PULSE.defaults);
  await savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'loadup', name: 'slow', settings: { riseMs: 2500, topPulses: 5 } }, PULSE.defaults);
  await savePhaseFile(lib, { tag: 'SOTA.PLS', phase: 'beat', name: 'tight', settings: { bpmMin: 170, bpmMax: 176 } }, PULSE.defaults);
  const routine = await saveRoutine(lib, {
    tag: 'SOTA.PLS', name: 'club_night', phases: { loadup: 'slow@1', beat: 'tight' }, shared: { brightness: 200, red: [250, 10, 10] },
  }, PULSE.defaults);
  assert.deepEqual((await lib.routines('pulse')).map((r) => r.data.name), ['club_night']);

  const settings = await applyRoutine(lib, routine, PULSE);
  assert.equal(settings.riseMs, 2000, 'pinned to version 1');
  assert.equal(settings.topPulses, PULSE.defaults.topPulses);
  assert.equal(settings.bpmMax, 176);
  assert.deepEqual(describeChanges(settings, PULSE.defaults).sort(), ['bpmMax', 'bpmMin', 'brightness', 'red', 'riseMs']);
  const latest = await applyRoutine(lib, { ...routine, phases: { loadup: 'slow' } }, PULSE);
  assert.equal(latest.riseMs, 2500, 'newest version when not pinned');

  const chip = new SimChip('attiny1614');
  const t = new SimTransport(chip);
  const first = await checkBoard(t, 'pulse', { engines: [CORE, PULSE] });
  const image = buildInitImage(PULSE, settings);
  const card = encodeCard({ family: 'P', number: 1, board: 'Pulse A2', casing: 'SOTA' });
  await initialiseBoard(t, { family: 'pulse', image, card, expectSerial: first.info.serial, engine: PULSE });
  const after = await checkBoard(t, 'pulse', { engines: [CORE, PULSE] });
  assert.deepEqual(after.onChip.settings, settings, 'the board holds exactly what the routine resolved to');
});

test('routines are refused for the wrong engine, a missing phase file, or a bad shared value', async () => {
  const lib = new Library(new MemoryStore());
  await assert.rejects(saveRoutine(lib, { tag: 'SOTA.PLS', name: 'r', phases: { loadup: 'nope' } }, PULSE.defaults), /isn't in the library/);
  await assert.rejects(saveRoutine(lib, { tag: 'SOTA.PLS', name: 'r', shared: { riseMs: 5 } }), /isn't a shared setting/);
  await assert.rejects(saveRoutine(lib, { tag: 'SOTA.PLS', name: 'r', shared: { brightness: 300 } }, PULSE.defaults), /brightness/);
  const r = await saveRoutine(lib, { tag: 'SOTA.PLS', name: 'r' }, PULSE.defaults);
  await assert.rejects(applyRoutine(lib, r, CORE), /not/);
});
