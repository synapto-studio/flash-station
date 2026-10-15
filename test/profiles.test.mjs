import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfile, makeProfile, isProfile, profileFileName, groupOf, drawnLeds } from '../js/profiles.js';
import { makePhaseFile } from '../js/phases.js';
import { makePalette } from '../js/palettes.js';
import { makeRoutine, engineToPreview } from '../js/routines.js';
import { Library, MemoryStore, resolveRoutine } from '../js/library.js';
import { SimChip, SimTransport } from '../js/sim.js';
import { buildInitImage } from '../js/engines.js';
import { encodeCard } from '../js/idcard.js';
import { checkBoard, initialiseBoard } from '../js/initialise.js';
import { demoEngines } from '../js/demo.js';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

const [CORE, PULSE] = demoEngines();

test('the built-in profiles are valid and keep the positions the preview always used', () => {
  for (const f of ['core', 'pulse']) assert.ok(isProfile(defaultProfile(f)), f);
  const p = defaultProfile('pulse');
  assert.equal(p.count, 8);
  assert.deepEqual(drawnLeds(p).map((l) => l.led), [1, 2, 3, 5], 'from the plug up');
  assert.equal(groupOf(p, 5), 'top');
  assert.equal(groupOf(p, 7), '');
  assert.equal(defaultProfile('core').count, 6);
});

test('a profile is checked when it is made', () => {
  const p = makeProfile('pulse', ' SOTA ', { groups: { low: [1, 2] }, leds: [{ led: 2, x: '3.5', y: 6 }, { led: 1, x: -3.5, y: 6 }] });
  assert.equal(p.name, 'SOTA');
  assert.deepEqual(p.leds.map((l) => l.led), [1, 2], 'sorted, numbers read as numbers');
  assert.equal(p.leds[1].x, 3.5);
  assert.equal(profileFileName(p), 'sota-pulse.json');
  assert.throws(() => makeProfile('pulse', '', { leds: p.leds }), /name/);
  assert.throws(() => makeProfile('pulse', 'x', {}), /at least one LED/);
  assert.throws(() => makeProfile('pulse', 'x', { leds: [{ led: 9, x: 0, y: 0 }] }), /1 to 8/);
  assert.throws(() => makeProfile('pulse', 'x', { leds: [{ led: 1, x: 0, y: 0 }, { led: 1, x: 1, y: 1 }] }), /used once/);
  assert.throws(() => makeProfile('pulse', 'x', { leds: [{ led: 1, x: 'a', y: 0 }] }), /x and y/);
  assert.throws(() => makeProfile('pulse', 'x', { groups: { g: [12] }, leds: [{ led: 1, x: 0, y: 0 }] }), /1 to 8/);
  assert.throws(() => makeProfile('toaster', 'x', {}), /Unknown board/);
});

test('profiles save in casings/, per board, and a casing code finds its own', async () => {
  const lib = new Library(new MemoryStore());
  const mine = makeProfile('pulse', 'SOTA', { leds: [{ led: 1, x: 0, y: 5 }, { led: 5, x: 0, y: 60 }], groups: { top: [5] } });
  await lib.saveProfile(mine);
  await lib.saveProfile(makeProfile('core', 'SOTA', { leds: [{ led: 3, x: 0, y: 50 }] }));
  assert.deepEqual(await lib.store.list('casings'), ['sota-core.json', 'sota-pulse.json']);
  assert.equal((await lib.profiles('pulse')).length, 1);
  assert.deepEqual(await lib.profileFor('sota', 'pulse'), mine);
  assert.equal((await lib.profileFor('NOPE', 'pulse')).estimate, true, 'unknown casing falls back to the estimate');
  await lib.saveProfile(makeProfile('pulse', 'SOTA', { leds: [{ led: 1, x: 0, y: 7 }] }));
  assert.equal((await lib.profiles('pulse')).length, 1, 'same casing and board replaces');
  await assert.rejects(lib.saveProfile({ type: 'profile' }), /not complete/);
  await lib.writeJson('casings', 'junk.json', { hello: 1 });
  assert.equal((await lib.profiles()).length, 2, 'files that are not profiles are ignored');
});

// The finish line for task 4: build a routine, put it on a simulated board, check the board and the preview.
for (const [family, device, engine, bootend] of [['core', 'attiny412', CORE, 0x00], ['pulse', 'attiny1614', PULSE, 0x0c]]) {
  test(`${family}: a routine built from saved files initialises a simulated board and the preview matches`, async () => {
    const lib = new Library(new MemoryStore());
    const base = family === 'core' ? core.DEFAULTS : pulse.DEFAULTS;
    const tweak = (o) => ({ ...structuredClone(base), ...o });
    const [p1, p2, brightness] = family === 'core'
      ? [tweak({ WHITE_MS: 1500, WHITE_TO_RED_MS: 3000 }), tweak({ BREATHE_MS: 6000, BREATHE_MIN: 30 }), 180]
      : [tweak({ riseMs: 900, glowLevel: 120 }), tweak({ kickMin: 60, topPulses: 4 }), 180];
    await lib.savePhaseFile(makePhaseFile(family, 'loadup', 'Slow', p1));
    await lib.savePhaseFile(makePhaseFile(family, family === 'core' ? 'standard' : 'beat', 'Soft', p2));
    const colours = family === 'core' ? { ORANGE: [200, 60, 0], RED: [240, 10, 10] } : { orange: [200, 60, 0], red: [240, 10, 10] };
    const palette = makePalette(family, 'Dusk', tweak(colours));
    const routine = makeRoutine(family, 'Night', { phases: { loadup: 'Slow', [family === 'core' ? 'standard' : 'beat']: 'Soft' }, palette, brightness });
    await lib.saveRoutine(routine);

    // what the Routines tab shows for this routine
    const saved = (await lib.routines(family))[0].data;
    const resolved = await resolveRoutine(lib, saved, engine.defaults);
    const shown = engineToPreview(family, base, resolved);

    // put it on a simulated board, the way the Initialise tab does
    const chip = new SimChip(device);
    const t = new SimTransport(chip);
    const first = await checkBoard(t, family, { engines: [CORE, PULSE] });
    const image = buildInitImage(engine, resolved);
    const card = encodeCard({ family: family === 'core' ? 'C' : 'P', number: 1, board: family === 'core' ? 'Core A' : 'Pulse A2', casing: 'SOTA' });
    await initialiseBoard(t, { family, image, card, expectSerial: first.info.serial, engine });
    assert.equal(chip.fuses[8], bootend);

    // read the board back: the settings on the chip are the routine's, and the preview of them is what was shown
    const back = await checkBoard(t, family, { engines: [CORE, PULSE] });
    assert.equal(back.onChip.match, engine);
    const onChip = back.onChip.settings;
    assert.equal(onChip.brightness, 180);
    const seen = engineToPreview(family, base, onChip);
    assert.deepEqual(seen, shown, 'the preview of what is on the chip is the preview of the routine');
    if (family === 'core') {
      assert.equal(onChip.whiteMs, 1500);
      assert.deepEqual(onChip.orange, [200, 60, 0]);
      for (let ms = 0; ms < 20000; ms += 10) assert.deepEqual(core.render(seen, ms), core.render(shown, ms), `t=${ms}`);
      assert.notDeepEqual(core.render(seen, 100), core.render(core.DEFAULTS, 100), 'and it differs from the defaults');
    } else {
      assert.equal(onChip.riseMs, 900);
      assert.equal(onChip.kickMin, 60);
      assert.deepEqual(onChip.red, [240, 10, 10]);
      const demo = pulse.synthDnb(8000, { bars: 8 });
      const s1 = pulse.stage1(pulse.micVolts(demo.audio, 8000, 'club', 1, 7), 8000);
      assert.deepEqual(pulse.stage2(s1, seen).leds, pulse.stage2(s1, shown).leds);
    }
  });
}
