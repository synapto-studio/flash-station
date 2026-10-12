import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHex, toHex, slice } from '../js/intelhex.js';
import { readEngine, buildInitImage, packSettings, unpackSettings, layoutSize, initImageToMem } from '../js/engines.js';
import { encodeCard, decodeCard } from '../js/idcard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'fs-'));

function rand(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
}

// pulsetest 1.0 defaults, from the SETTINGS initialiser in sota_pulse.ino
const PULSE_DEFAULTS = {
  tag: 'SOTA.PLS', layout: 1, brightness: 255,
  white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0],
  riseMs: 1200, topPulseMs: 1000, multiMs: 2000, pourMs: 1000, whiteMs: 2000, drainMs: 800, flowMs: 1000,
  topPulses: 3, glowLevel: 150, bottomLevel: 170, middleLevel: 80, topHigh: 215, topLow: 180, cycleBars: 4,
  bpmX10: 1740, bpmMin: 165, bpmMax: 180, leadMs: 20, micTrimDb: 0, loudTop: 85, loudMiddle: 95, loudBottom: 100,
  kickFadeMs: 160, kickMin: 90, kickJumpX10: 14, kickLoudX10: 15, kickMinPct: 45, kickFloorUv: 200, kickGapMs: 150,
  snareJumpX10: 16, snareLoudX10: 35, snareMinPct: 50, snareFloorUv: 20,
};

function fakePulse() {
  const r = rand(5);
  const app = new Uint8Array(12372).map(() => r());
  app.set(packSettings('SOTA.PLS', PULSE_DEFAULTS), 3 * 64);
  const boot = new Uint8Array(2988).map(() => r());
  const appMem = new Map();
  app.forEach((b, i) => appMem.set(0x0c00 + i, b));
  const bootMem = new Map();
  boot.forEach((b, i) => bootMem.set(i, b));
  return { appMem, bootMem };
}

function python(args) {
  return execFileSync('python3', [join(HERE, 'ref_pulse_station.py'), ...args], { encoding: 'utf8' }).trim();
}

test('pulsetest settings layout is 64 bytes and round-trips', () => {
  assert.equal(layoutSize('SOTA.PLS'), 64);
  const b = packSettings('SOTA.PLS', PULSE_DEFAULTS);
  assert.deepEqual(unpackSettings('SOTA.PLS', b), PULSE_DEFAULTS);
});

for (const [name, sets, jsSets] of [
  ['defaults', [], {}],
  ['changed settings', ['riseMs=1500', 'white=1,2,3', 'micTrimDb=-3'], { riseMs: 1500, white: [1, 2, 3], micTrimDb: -3 }],
]) {
  test(`pulsetest image matches the Pi tool byte for byte (${name})`, () => {
    const { appMem, bootMem } = fakePulse();
    const appHex = join(TMP, 'app.hex');
    const bootHex = join(TMP, 'boot.hex');
    const outHex = join(TMP, `full-${name}.hex`);
    writeFileSync(appHex, toHex(appMem));
    writeFileSync(bootHex, toHex(bootMem));
    const pyId = python(['image', appHex, bootHex, outHex, ...sets]);
    const pyMem = parseHex(readFileSync(outHex, 'utf8'));

    const mem = new Map([...bootMem, ...appMem]);
    const engine = readEngine(mem, 'pulse_1.0_full.hex');
    assert.equal(engine.kind, 'pulsetest');
    assert.deepEqual(engine.defaults, PULSE_DEFAULTS);
    const img = buildInitImage(engine, { ...engine.defaults, ...jsSets });
    assert.deepEqual(img.flash, slice(pyMem, 0, 0x4000));
    assert.equal(img.bootend, pyMem.get(0x820008));
    assert.equal(img.imageId.toString(16).toUpperCase().padStart(4, '0'), pyId);

    // Reading the Pi tool's own full .hex back gives the same image again.
    const again = buildInitImage(readEngine(pyMem, 'pulse_1.0_full.hex'));
    assert.deepEqual(again.flash, img.flash);
    assert.equal(again.imageId, img.imageId);

    // The Terminal-fallback .hex holds the same bytes and the fuse.
    const fallback = initImageToMem(img);
    assert.deepEqual(slice(fallback, 0, 0x4000), img.flash);
    assert.equal(fallback.get(0x820008), 0x0c);
  });
}

test('pulsetest app-only file is refused for initialising', () => {
  const { appMem } = fakePulse();
  const engine = readEngine(appMem, 'pulse_1.0_app.hex');
  assert.equal(engine.hasBootloader, false);
  assert.throws(() => buildInitImage(engine), /no bootloader/);
});

// coretest 1.2 defaults, from the SETTINGS initialiser in sota_leds.ino
const CORE_DEFAULTS = {
  tag: 'SOTA.LED', layout: 1, brightness: 255,
  white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0], yellow: [255, 140, 0],
  startupDim: 40, whiteMs: 1000, whiteToRedMs: 2500, colourStepMs: 5000, catchMs: 350, catchFrom: 110,
  breatheMs: 4000, breatheMin: 70, numCranks: 10,
  cranks: [[0, 150, 0], [60, 260, 90], [70, 220, 140], [40, 180, 70], [80, 150, 190], [60, 110, 160],
    [60, 80, 220], [50, 60, 200], [50, 45, 240], [45, 35, 255], [0, 0, 0], [0, 0, 0]],
};

test('coretest: settings found, patched in place, nothing else changes', () => {
  assert.equal(layoutSize('SOTA.LED'), 106);
  const r = rand(9);
  const flash = new Uint8Array(3448).map(() => r());
  const at = 2001;
  flash.set(packSettings('SOTA.LED', CORE_DEFAULTS), at);
  const mem = new Map();
  flash.forEach((b, i) => mem.set(i, b));
  const engine = readEngine(mem, 'sota_leds_v1.2_10mhz.hex');
  assert.equal(engine.kind, 'coretest');
  assert.equal(engine.clock, 10);
  assert.equal(engine.label, 'coretest 1.2 · 10 MHz');
  assert.deepEqual(engine.defaults, CORE_DEFAULTS);
  const img = buildInitImage(engine, { ...engine.defaults, brightness: 128, red: [200, 0, 10] });
  assert.equal(img.bootend, 0);
  const changed = [...img.flash.keys()].filter((i) => img.flash[i] !== flash[i]);
  assert.ok(changed.length > 0 && changed.every((i) => i >= at && i < at + 106));
  assert.equal(img.settings.brightness, 128);
});

test('Beat: SOTA.MIC block is 53 bytes (45 after the tag, as the power-line receiver expects)', () => {
  assert.equal(layoutSize('SOTA.MIC') - 8, 45);
});

test('bad settings are refused with a clear message', () => {
  assert.throws(() => packSettings('SOTA.PLS', { ...PULSE_DEFAULTS, brightness: 300 }), /brightness must be/);
  assert.throws(() => packSettings('SOTA.PLS', { ...PULSE_DEFAULTS, tag: 'SOTA.LED' }), /Settings are for/);
});

test('ID card round-trips and rejects damage', () => {
  const card = encodeCard({ family: 'P', number: 7, board: 'Pulse A2', casing: 'sota', date: new Date(Date.UTC(2026, 9, 12)) });
  assert.equal(card.length, 32);
  const d = decodeCard(card);
  assert.deepEqual(d, { version: 1, family: 'P', number: 7, label: 'P-0007', board: 'Pulse A2', casing: 'SOTA', date: '2026-10-12' });
  card[6] ^= 1;
  assert.equal(decodeCard(card), null);
  assert.equal(decodeCard(new Uint8Array(32).fill(0xff)), null);
});

test('Intel HEX round trip, including the fuse segment', () => {
  const mem = new Map([[0, 1], [1, 2], [0xffff, 3], [0x10000, 4], [0x820008, 0x0c]]);
  assert.deepEqual(parseHex(toHex(mem)), mem);
  assert.throws(() => parseHex(':0100000001FF\n'), /checksum/);
});
