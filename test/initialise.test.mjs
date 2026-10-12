import test from 'node:test';
import assert from 'node:assert/strict';
import { SimChip, SimTransport } from '../js/sim.js';
import { demoEngines } from '../js/demo.js';
import { buildInitImage } from '../js/engines.js';
import { encodeCard, decodeCard } from '../js/idcard.js';
import { checkBoard, initialiseBoard, driveRecord, explain } from '../js/initialise.js';
import { Library, MemoryStore, resolveRoutine } from '../js/library.js';

const [CORE, PULSE] = demoEngines();

for (const [family, device, engine, bootend] of [['core', 'attiny412', CORE, 0x00], ['pulse', 'attiny1614', PULSE, 0x0c]]) {
  test(`${family}: check a blank board, initialise it, check it again`, async () => {
    const chip = new SimChip(device);
    const t = new SimTransport(chip);
    const first = await checkBoard(t, family, { engines: [CORE, PULSE] });
    assert.equal(first.onChip.blank, true);
    assert.equal(first.card, null);

    const settings = { ...engine.defaults, brightness: 200, red: [250, 5, 5] };
    const image = buildInitImage(engine, settings);
    const card = encodeCard({ family: family === 'core' ? 'C' : 'P', number: 3, board: family === 'core' ? 'Core A' : 'Pulse A2', casing: 'SOTA' });
    const steps = new Set();
    await initialiseBoard(t, { family, image, card, expectSerial: first.info.serial, engine, onStep: (s) => steps.add(s) });
    assert.deepEqual([...steps], ['erase', 'write', 'verify', 'fuse', 'card', 'done']);
    assert.deepEqual(chip.flash.subarray(0, image.flash.length), image.flash);
    assert.equal(chip.fuses[8], bootend);
    assert.deepEqual(chip.userRow, card);
    assert.equal(chip.nvmProg, false, 'chip left running');

    const second = await checkBoard(t, family, { engines: [CORE, PULSE] });
    assert.equal(second.onChip.match, engine, 'recognised as the same engine');
    assert.equal(second.onChip.settings.brightness, 200);
    assert.equal(second.card.label, family === 'core' ? 'C-0003' : 'P-0003');
  });
}

test('re-initialising a Pulse board that had Beat-style BOOTEND 0 sets it to 0x0C, and back', async () => {
  const chip = new SimChip('attiny1614');
  const t = new SimTransport(chip);
  const card = encodeCard({ family: 'P', number: 1, board: 'Pulse A1' });
  await initialiseBoard(t, { family: 'pulse', image: buildInitImage(PULSE), card, engine: PULSE });
  assert.equal(chip.fuses[8], 0x0c);
  await initialiseBoard(t, { family: 'pulse', image: { ...buildInitImage(PULSE), bootend: 0 }, card, engine: PULSE });
  assert.equal(chip.fuses[8], 0x00);
});

test('wrong board selected: refused, with what to do', async () => {
  const t = new SimTransport(new SimChip('attiny412'));
  await assert.rejects(checkBoard(t, 'pulse'), (e) => {
    const msg = explain(e, 'pulse');
    return e.code === 'wrong-board' && /Core board/.test(msg) && /5V/.test(msg);
  });
});

test('board swapped between check and initialise: refused', async () => {
  const t = new SimTransport(new SimChip('attiny412'));
  const card = encodeCard({ family: 'C', number: 1, board: 'Core A' });
  await assert.rejects(
    initialiseBoard(t, { family: 'core', image: buildInitImage(CORE), card, expectSerial: 'NOT-THIS-ONE', engine: CORE }),
    (e) => e.code === 'other-board',
  );
});

test('demo engines never go on a real programmer', async () => {
  const realish = new SimTransport(new SimChip('attiny412'));
  realish.simulated = false;
  const card = encodeCard({ family: 'C', number: 1, board: 'Core A' });
  await assert.rejects(
    initialiseBoard(realish, { family: 'core', image: buildInitImage(CORE), card, engine: CORE }),
    (e) => e.code === 'demo-engine',
  );
});

test('no chip on the pin: plain-English message', async () => {
  const t = new SimTransport(null);
  await assert.rejects(checkBoard(t, 'pulse'), (e) => /pogo pin/.test(explain(e, 'pulse')) && /6R1/.test(explain(e, 'pulse')));
});

test('library: register, numbering and routines from phase files', async () => {
  const lib = new Library(new MemoryStore());
  assert.equal(await lib.nextNumber('P'), 1);
  const t = new SimTransport(new SimChip('attiny1614'));
  const checked = await checkBoard(t, 'pulse');
  const image = buildInitImage(PULSE);
  const rec = driveRecord({ label: 'P-0001', family: 'P', number: 1, board: 'Pulse A2', casing: 'SOTA', info: checked.info, engine: PULSE, image, settings: image.settings });
  await lib.saveDrive(rec);
  assert.equal(await lib.nextNumber('P'), 2);
  assert.equal(await lib.nextNumber('C'), 1);
  assert.equal((await lib.findDrive({ chipSerial: checked.info.serial })).drive, 'P-0001');

  await lib.writeJson('phases', 'loadup_fast.json', { type: 'phase', phase: 'loadup', name: 'loadup_fast', version: 1, settings: { riseMs: 600 } });
  await lib.writeJson('phases', 'loadup_fast_v2.json', { type: 'phase', phase: 'loadup', name: 'loadup_fast', version: 2, settings: { riseMs: 700 } });
  const routine = { name: 'routine_test', family: 'pulse', phases: { loadup: 'loadup_fast' }, shared: { brightness: 180 } };
  const s = await resolveRoutine(lib, routine, PULSE.defaults);
  assert.equal(s.riseMs, 700, 'newest version by default');
  assert.equal(s.brightness, 180);
  assert.equal(s.flowMs, PULSE.defaults.flowMs, 'untouched phases keep the defaults');
  const v1 = await resolveRoutine(lib, { ...routine, phases: { loadup: 'loadup_fast@1' } }, PULSE.defaults);
  assert.equal(v1.riseMs, 600, 'a pinned version');
  await assert.rejects(resolveRoutine(lib, { ...routine, phases: { standard: 'nope' } }, PULSE.defaults), /isn't in the library/);
  assert.equal(decodeCard(encodeCard({ family: 'P', number: 1, board: 'Pulse A2' })).label, 'P-0001');
});
