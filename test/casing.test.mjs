// The 3D drive's code (js/casing-model.js, js/drive-3d.js) and where casing models live (a drive
// profile names one; the file sits in the library's casings/ folder). The casing itself is private:
// these tests make a small box model of their own. The real model is only read when the firmware
// repo sits next to this one (it is never committed here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readCasing, bounds } from '../js/casing-model.js';
import { ledSpots, FACING } from '../js/drive-3d.js';
import { defaultProfile, makeProfile, isProfile, isModelName } from '../js/profiles.js';
import { Library, MemoryStore } from '../js/library.js';

// A .casing file holding one box part (and a stand-in), as casing/tools/stl_to_web.py writes them.
function boxCasing({ lo = [-10, -5, -2], hi = [10, 5, 70], plugTopZ = 0, format = 1 } = {}) {
  const corners = [];
  for (let k = 0; k < 8; k++) corners.push([k & 1, (k >> 1) & 1, (k >> 2) & 1]);
  const pos = new Uint16Array(corners.flatMap((c) => c.map((v) => v * 65535)));
  const nrm = new Int8Array(corners.flatMap((c) => c.map((v) => (v ? 73 : -73))));
  const idx = new Uint16Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);
  const blob = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const pad = (n) => (4 - (n % 4)) % 4;
  const parts = [], blobs = [];
  let at = 0;
  for (const [name, look, min, max, standIn] of [['Body', 'shell', lo, hi, false], ['Board (stand-in)', 'board', [-8, -0.5, 0], [8, 0.5, 60], true]]) {
    const p = { name, look, vertices: 8, triangles: 12, indexBytes: 2, min, max, offsets: {} };
    if (standIn) p.standIn = true;
    p.offsets.position = at; blobs.push(blob(pos)); at += pos.byteLength;
    p.offsets.normal = at; blobs.push(blob(nrm), new Uint8Array(pad(nrm.byteLength))); at += nrm.byteLength + pad(nrm.byteLength);
    p.offsets.index = at; blobs.push(blob(idx)); at += idx.byteLength;
    parts.push(p);
  }
  const header = new TextEncoder().encode(JSON.stringify({ type: 'casing-model', format, name: 'Test box', code: 'TBOX', model: 1, units: 'mm', plugTopZ, frontY: 1, board: { y: 0, thickness: 1 }, parts }));
  const out = new Uint8Array(8 + header.length + at);
  out.set([0x53, 0x59, 0x4e, 0x33]);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  let o = 8 + header.length;
  for (const b of blobs) { out.set(b, o); o += b.length; }
  return out;
}

test('a casing model file reads back: its parts, their corners and triangles, its size', () => {
  const m = readCasing(boxCasing());
  assert.equal(m.name, 'Test box');
  assert.equal(m.parts.length, 2);
  const [body, board] = m.parts;
  assert.equal(body.position.length, 24);
  assert.equal(body.normal[0], -73);
  assert.equal(body.index.length, 36);
  assert.ok(body.index.every((i) => i < 8));
  assert.equal(board.standIn, true);
  assert.deepEqual(bounds(m), { min: [-10, -5, -2], max: [10, 5, 70] });
  assert.deepEqual(bounds(m, { standIns: false }), { min: [-10, -5, -2], max: [10, 5, 70] });
  // from an ArrayBuffer too (what the library hands over)
  assert.equal(readCasing(boxCasing().buffer).parts.length, 2);
});

test('a file that isn\'t a casing model is refused with a sentence', () => {
  assert.throws(() => readCasing(new TextEncoder().encode('{"type":"profile"}')), /isn't a casing model file/);
  assert.throws(() => readCasing(new Uint8Array(3)), /isn't a casing model file/);
  assert.throws(() => readCasing(boxCasing({ format: 2 })), /newer format/);
});

test('the LEDs sit where the profile says, the back ones behind the front ones they face', () => {
  const m = readCasing(boxCasing({ plugTopZ: 2.5 }));
  for (const family of ['pulse', 'core']) {
    const p = defaultProfile(family), spots = ledSpots(m, p);
    assert.equal(spots.length, p.count, `${family}: every LED has a place`);
    for (const l of p.leds) {
      const s = spots.find((q) => q.led === l.led);
      assert.equal(s.side, 1, `${family} LED ${l.led} faces the front`);
      assert.deepEqual([s.pos[0], s.pos[2]], [l.x, 2.5 + l.y], `${family} LED ${l.led}: x across, height from where the profile's heights start`);
      assert.ok(s.pos[1] > 0.5, 'in front of the board');
    }
    for (const [back, front] of Object.entries(FACING[family])) {
      const b = spots.find((q) => q.led === Number(back)), f = spots.find((q) => q.led === front);
      assert.equal(b.side, -1, `${family} LED ${back} is on the back`);
      assert.deepEqual([b.pos[0], b.pos[2]], [f.pos[0], f.pos[2]], `${family} LED ${back} sits behind LED ${front}`);
      assert.ok(b.pos[1] < -0.5, 'behind the board');
    }
  }
});

test('a drive profile can name its 3D model, and is checked', () => {
  assert.equal(defaultProfile('pulse').model, undefined, 'the estimate has none: the drawing');
  const leds = defaultProfile('pulse').leds;
  const p = makeProfile('pulse', 'SOTA', { leds, model: 'sota-pro-3.0_model2.casing' });
  assert.equal(p.model, 'sota-pro-3.0_model2.casing');
  assert.ok(isProfile(p));
  assert.equal(makeProfile('pulse', 'SOTA', { leds, model: '' }).model, undefined, 'none picked: no model');
  assert.ok(!('model' in makeProfile('pulse', 'SOTA', { leds })));
  for (const bad of ['model.json', '../x.casing', 'a/b.casing', '.casing']) {
    assert.ok(!isModelName(bad), bad);
    assert.throws(() => makeProfile('pulse', 'SOTA', { leds, model: bad }), /isn't a casing model file name/, bad);
    assert.ok(!isProfile({ ...p, model: bad }), bad);
  }
  assert.ok(!isProfile({ ...p, model: 7 }));
  assert.ok(isModelName('SOTA PRO 3.0 model 2.CASING'));
});

test('casing models live in the library\'s casings folder, next to the profiles', async () => {
  const lib = new Library(new MemoryStore());
  assert.deepEqual(await lib.casingModels(), []);
  const model = await lib.addCasingModel('test-box_model1.casing', boxCasing());
  assert.equal(model.name, 'Test box');
  const leds = defaultProfile('pulse').leds;
  await lib.saveProfile(makeProfile('pulse', 'TBOX', { leds, model: 'test-box_model1.casing' }));
  assert.deepEqual(await lib.casingModels(), ['test-box_model1.casing'], 'the profile .json isn\'t a model');
  assert.deepEqual((await lib.profiles('pulse')).map((p) => p.name), ['TBOX'], 'the model file isn\'t a profile');
  const p = await lib.profileFor('tbox', 'pulse');
  assert.equal(p.model, 'test-box_model1.casing', 'the saved profile keeps its model');
  const back = await lib.readCasingModel(p.model);
  assert.equal(back.parts[0].index.length, 36);
  await assert.rejects(() => lib.readCasingModel('sota-pro-3.0_model2.casing'), /isn't in the library's casings folder/);
  await assert.rejects(() => lib.addCasingModel('box.stl', boxCasing()), /ends in \.casing/);
  await assert.rejects(() => lib.addCasingModel('box.casing', new TextEncoder().encode('hello')), /isn't a casing model file/);
  assert.deepEqual(await lib.casingModels(), ['test-box_model1.casing'], 'nothing written for a refused file');
});

// Only when the private firmware repo is next to this one: the real model and the app's Pulse profile.
const REAL = new URL('../../firmware/casing/out/sota-pro-3.0_model2.casing', import.meta.url);
test('SOTA PRO 3.0 (firmware repo): every Pulse LED is inside the casing', { skip: !existsSync(REAL) && 'firmware repo not next to this one' }, () => {
  const m = readCasing(readFileSync(REAL));
  const b = bounds(m, { standIns: false });
  const spots = ledSpots(m, defaultProfile('pulse'));
  assert.equal(spots.length, 8);
  for (const s of spots) for (let k = 0; k < 3; k++) assert.ok(s.pos[k] > b.min[k] && s.pos[k] < b.max[k], `LED ${s.led} axis ${k}`);
  assert.ok(m.parts.some((p) => p.group === 'cap'), 'the cap the preview takes off');
});
