import test from 'node:test';
import assert from 'node:assert/strict';
import { SimChip, SimTransport } from '../js/sim.js';
import { demoEngines } from '../js/demo.js';
import { buildInitImage, LAYOUTS } from '../js/engines.js';
import { encodeCard } from '../js/idcard.js';
import { checkBoard, initialiseBoard } from '../js/initialise.js';
import { Library, MemoryStore } from '../js/library.js';
import { steadyLeds } from '../js/drive-art.js';
import {
  savePhase, savePalette, saveRoutine, resolveRoutine, saveProfile, defaultProfile, checkProfile,
  phaseFields, phaseFiles, slug,
} from '../js/routines.js';

const [CORE, PULSE] = demoEngines();
const lib = () => new Library(new MemoryStore());

test('phase fields come from the layout, one phase each', () => {
  const names = phaseFields('SOTA.PLS', 'loadup').map((f) => f[0]);
  assert.ok(names.includes('riseMs') && !names.includes('bottomLevel'));
  assert.equal(phaseFields('SOTA.PLS', 'recognition').length, 0);
  // every layout field with a phase is reachable from some editor phase
  for (const tag of Object.keys(LAYOUTS)) {
    for (const f of LAYOUTS[tag]) if (f[2]) assert.ok(['shared', 'loadup', 'standard', 'beat'].includes(f[2]), `${tag}.${f[0]}`);
  }
});

test('saving a phase file again makes the next version and keeps the old one', async () => {
  const l = lib();
  const a = await savePhase(l, { name: 'Calm', phase: 'standard', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: { bottomLevel: 100, middleLevel: 60, topHigh: 200, topLow: 150, cycleBars: 8, bpmX10: 1200 } });
  const b = await savePhase(l, { name: 'Calm', phase: 'standard', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: { ...a.settings, bottomLevel: 120 } });
  assert.deepEqual([a.version, b.version], [1, 2]);
  const files = await phaseFiles(l, 'standard', 'SOTA.PLS');
  assert.deepEqual(files.map((f) => `${f.name}@${f.version}`), ['Calm@2', 'Calm@1']);
  assert.equal(files[1].settings.bottomLevel, 100, 'version 1 untouched');
});

test('a phase file only stores its own phase, and refuses values that do not fit', async () => {
  const l = lib();
  const all = { ...PULSE.defaults, riseMs: 900, bottomLevel: 5 };
  const p = await savePhase(l, { name: 'Quick', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: all });
  assert.equal(p.settings.riseMs, 900);
  assert.equal('bottomLevel' in p.settings, false);
  await assert.rejects(savePhase(l, { name: 'Bad', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: { ...p.settings, glowLevel: 300 } }), /glowLevel must be a whole number 0–255/);
  await assert.rejects(savePhase(l, { name: '', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: p.settings }), /name/);
  await assert.rejects(savePhase(l, { name: 'a@b', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: p.settings }), /@/);
  await assert.rejects(savePhase(l, { name: 'X', phase: 'recognition', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: {} }), /no recognition settings/);
});

test('palettes only hold colours', async () => {
  const l = lib();
  const p = await savePalette(l, { name: 'Ice', tag: 'SOTA.PLS', defaults: PULSE.defaults, colours: { red: [0, 120, 255], orange: [0, 200, 255] } });
  assert.deepEqual((await l.palettes()).map((x) => x.name), ['Ice']);
  assert.deepEqual(p.colours.red, [0, 120, 255]);
  await assert.rejects(savePalette(l, { name: 'Bad', tag: 'SOTA.PLS', defaults: PULSE.defaults, colours: { brightness: [1, 2, 3] } }), /isn't a colour/);
  await assert.rejects(savePalette(l, { name: 'Bad', tag: 'SOTA.PLS', defaults: PULSE.defaults, colours: { red: [0, 0, 999] } }), /0–255/);
});

test('a routine resolves phase files, then the colour set, then shared values', async () => {
  const l = lib();
  await savePhase(l, { name: 'Slow', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: { ...PULSE.defaults, riseMs: 2400 } });
  await savePhase(l, { name: 'Slow', phase: 'loadup', tag: 'SOTA.PLS', defaults: PULSE.defaults, settings: { ...PULSE.defaults, riseMs: 3000 } });
  await savePalette(l, { name: 'Ice', tag: 'SOTA.PLS', defaults: PULSE.defaults, colours: { red: [0, 120, 255] } });
  const r = await saveRoutine(l, { name: 'Ice show', tag: 'SOTA.PLS', defaults: PULSE.defaults, phases: { loadup: 'Slow@1' }, palette: 'Ice', shared: { brightness: 180, red: [1, 2, 3] } });
  const s = await resolveRoutine(l, r, PULSE.defaults);
  assert.equal(s.riseMs, 2400, 'pinned to version 1');
  assert.equal(s.brightness, 180);
  assert.deepEqual(s.red, [1, 2, 3], 'shared beats the colour set');
  assert.equal(s.bottomLevel, PULSE.defaults.bottomLevel, 'untouched phases keep the engine look');
  const latest = await resolveRoutine(l, { ...r, phases: { loadup: 'Slow' }, shared: {} }, PULSE.defaults);
  assert.equal(latest.riseMs, 3000, 'no version means the newest');
  assert.deepEqual(latest.red, [0, 120, 255], 'colour set applies');
});

test('a routine naming something missing is refused with what is missing', async () => {
  const l = lib();
  await assert.rejects(saveRoutine(l, { name: 'R', tag: 'SOTA.PLS', defaults: PULSE.defaults, phases: { loadup: 'Nope' } }), /Nope.*isn't in the library/);
  await assert.rejects(saveRoutine(l, { name: 'R', tag: 'SOTA.PLS', defaults: PULSE.defaults, palette: 'Nope' }), /colour set Nope/);
  await assert.rejects(saveRoutine(l, { name: 'R', tag: 'SOTA.PLS', defaults: PULSE.defaults }), /at least one/);
  assert.deepEqual(await l.routines(), []);
});

test('phase files for another engine are not offered to this one', async () => {
  const l = lib();
  await savePhase(l, { name: 'Core glow', phase: 'loadup', tag: 'SOTA.LED', defaults: CORE.defaults, settings: { ...CORE.defaults, whiteMs: 500 } });
  await assert.rejects(resolveRoutine(l, { name: 'R', phases: { loadup: 'Core glow' } }, PULSE.defaults), /isn't in the library for this engine/);
  assert.equal((await resolveRoutine(l, { name: 'R', phases: { loadup: 'Core glow' } }, CORE.defaults)).whiteMs, 500);
});

test('core routine with cranks round-trips through a phase file', async () => {
  const l = lib();
  const cranks = CORE.defaults.cranks.map((c, i) => (i === 1 ? [99, 200, 120] : c));
  await savePhase(l, { name: 'Rough', phase: 'loadup', tag: 'SOTA.LED', defaults: CORE.defaults, settings: { ...CORE.defaults, cranks } });
  const s = await resolveRoutine(l, { name: 'R', phases: { loadup: 'Rough' } }, CORE.defaults);
  assert.deepEqual(s.cranks[1], [99, 200, 120]);
});

test('drive profiles: defaults are valid and match the drawing, bad ones are refused', async () => {
  for (const f of ['pulse', 'core']) checkProfile(defaultProfile(f));
  const l = lib();
  const saved = await saveProfile(l, defaultProfile('pulse', 'sota'));
  assert.equal(saved.code, 'SOTA');
  assert.equal((await l.profiles()).length, 1);
  const p = defaultProfile('pulse');
  assert.throws(() => checkProfile({ ...p, leds: p.leds.slice(1) }), /needs 8 LEDs/);
  assert.throws(() => checkProfile({ ...p, leds: p.leds.map((x) => ({ ...x, n: 1 })) }), /listed twice/);
  assert.throws(() => checkProfile({ ...p, leds: p.leds.map((x) => ({ ...x, position: 2 })) }), /plug/);
  assert.throws(() => checkProfile({ ...p, leds: p.leds.map((x) => ({ ...x, group: 'side' })) }), /group/);
  assert.throws(() => checkProfile({ ...p, code: 'TOOLONG' }), /casing code/);
});

test('slug is safe for file names', () => {
  assert.equal(slug('  Ice show / v2! '), 'ice-show-v2');
});

// The roadmap's "done when": build a routine, initialise a simulated board with it, and the
// preview shows what was actually sent.
for (const [family, device, engine] of [['pulse', 'attiny1614', PULSE], ['core', 'attiny412', CORE]]) {
  test(`${family}: a routine built in the editor initialises a simulated board and the preview matches`, async () => {
    const l = lib();
    const tag = engine.tag;
    const loadup = family === 'pulse' ? { ...engine.defaults, riseMs: 1800 } : { ...engine.defaults, whiteMs: 700 };
    const standard = family === 'pulse' ? { ...engine.defaults, bottomLevel: 120, middleLevel: 40, topHigh: 230 } : { ...engine.defaults, breatheMs: 3000 };
    await savePhase(l, { name: 'Mine', phase: 'loadup', tag, defaults: engine.defaults, settings: loadup });
    await savePhase(l, { name: 'Mine', phase: 'standard', tag, defaults: engine.defaults, settings: standard });
    await savePalette(l, { name: 'Ice', tag, defaults: engine.defaults, colours: { red: [0, 90, 255], orange: [0, 160, 255] } });
    const routine = await saveRoutine(l, { name: 'Mine', tag, defaults: engine.defaults, phases: { loadup: 'Mine', standard: 'Mine' }, palette: 'Ice', shared: { brightness: 200 } });

    const wanted = await resolveRoutine(l, (await l.routines(family))[0].data, engine.defaults);
    const chip = new SimChip(device);
    const t = new SimTransport(chip);
    const first = await checkBoard(t, family, { engines: [CORE, PULSE] });
    const image = buildInitImage(engine, wanted);
    const card = encodeCard({ family: family === 'core' ? 'C' : 'P', number: 1, board: family === 'core' ? 'Core A' : 'Pulse A2', casing: 'SOTA' });
    await initialiseBoard(t, { family, image, card, expectSerial: first.info.serial, engine });
    const after = await checkBoard(t, family, { engines: [CORE, PULSE] });

    const onChip = after.onChip.settings;
    for (const k of ['brightness', 'red', 'orange']) assert.deepEqual(onChip[k], wanted[k], k);
    assert.deepEqual(onChip.red, [0, 90, 255]);
    assert.equal(onChip[family === 'pulse' ? 'riseMs' : 'whiteMs'], family === 'pulse' ? 1800 : 700);
    assert.equal(after.onChip.settings.brightness, 200);
    // the preview of what was sent equals the preview of what the chip now holds
    assert.deepEqual(steadyLeds(family, onChip), steadyLeds(family, wanted));
    assert.equal(routine.name, 'Mine');
  });
}
