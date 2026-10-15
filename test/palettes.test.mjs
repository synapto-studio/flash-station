import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePalette, applyPalette, isPalette, paletteFileName } from '../js/palettes.js';
import { Library, MemoryStore } from '../js/library.js';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

test('a Core set holds only the four colours and applies back unchanged', () => {
  const s = structuredClone(core.DEFAULTS);
  s.RED = [200, 10, 0];
  const p = makePalette('core', ' Warm ', s);
  assert.deepEqual(Object.keys(p.colours), ['WHITE', 'RED', 'YELLOW', 'ORANGE']);
  assert.equal(p.name, 'Warm');
  const out = applyPalette('core', { ...core.DEFAULTS, BRIGHTNESS: 100 }, p);
  assert.deepEqual(out.RED, [200, 10, 0]);
  assert.equal(out.BRIGHTNESS, 100); // other settings untouched
});

test('a Pulse set applies, and a set for the other board is refused', () => {
  const p = makePalette('pulse', 'Club', { ...pulse.DEFAULTS, red: [1, 2, 3] });
  assert.deepEqual(applyPalette('pulse', pulse.DEFAULTS, p).red, [1, 2, 3]);
  assert.throws(() => applyPalette('core', core.DEFAULTS, p), /not a Core colour set/);
});

test('names: blank refused, file name made safe', () => {
  assert.throws(() => makePalette('core', '  ', core.DEFAULTS), /name/);
  assert.equal(paletteFileName('Warm Club!'), 'warm-club.json');
  assert.throws(() => paletteFileName('!!!'), /name/);
});

test('isPalette rejects bad colours', () => {
  const p = makePalette('core', 'x', core.DEFAULTS);
  assert.ok(isPalette(p));
  p.colours.RED = [300, 0, 0];
  assert.ok(!isPalette(p));
  assert.ok(!isPalette(null));
});

test('library saves, lists per board, and replaces by name', async () => {
  const lib = new Library(new MemoryStore());
  await lib.savePalette(makePalette('core', 'Warm', core.DEFAULTS));
  await lib.savePalette(makePalette('pulse', 'Warm', pulse.DEFAULTS));
  await lib.savePalette(makePalette('core', 'Warm', { ...core.DEFAULTS, RED: [9, 9, 9] }));
  assert.equal((await lib.palettes('core')).length, 1);
  assert.deepEqual((await lib.palettes('core'))[0].colours.RED, [9, 9, 9]);
  assert.equal((await lib.palettes('pulse')).length, 1);
  assert.equal((await lib.palettes()).length, 2);
});
