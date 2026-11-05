// The Flash Station drive card in 3D (js/card-3d.js, firmware repo roadmap task 11b): what the card
// plays from the moment the drive went into the box, against the app's own player, and the casing
// models both tabs share (js/library.js CasingModels). The page itself is checked in headless Chromium.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationLook, REPORT_MS, OWN_FROM_MS } from '../js/card-3d.js';
import { DriveShow, defaultShow, demoShow, packShow, PLUGIN_MS } from '../js/show.js';
import { Show, makeDrive } from '../js/player.js';
import * as A from '../js/animations.js';
import * as pulse from '../js/preview-pulse.js';
import * as core from '../js/preview-core.js';
import { defaultProfile } from '../js/profiles.js';
import { steadyLeds } from '../js/drive-art.js';
import { CasingModels, Library, MemoryStore } from '../js/library.js';

const pulseDrive = (label, settings = null) => ({ drive: 'P-0002', family: 'pulse', board: 'Pulse A2', casing: 'SOTA', engine: { label }, settings });
// From the box's report to well into the heartbeats and the flow (38.6 s a loop), every 7 ms.
const times = () => { const t = []; for (let ms = REPORT_MS.pulse; ms < 45000; ms += 7) t.push(ms); return t; };

test('a Pulse on pulsetest 1.12 plays the box\'s plug-in animation, LED for LED as DriveShow.station', () => {
  const profile = defaultProfile('pulse');
  const look = stationLook({ family: 'pulse', drive: pulseDrive('pulsetest 1.12'), profile });
  assert.equal(look.joins, true);
  const ds = new DriveShow(defaultShow(pulse.DEFAULTS, profile));
  for (const t of times()) assert.deepEqual(look.at(t), ds.station(t), `${t} ms`);
  // in step with the box: the heartbeats start at its 2146 ms, whatever the drive's colours
  assert.notDeepEqual(look.at(PLUGIN_MS - 1), look.at(PLUGIN_MS + 90));
});

test('a Pulse engine 2 (2.5) plays its own show\'s plug-in animation', () => {
  const profile = defaultProfile('pulse');
  const show = defaultShow(pulse.DEFAULTS, profile);
  show.plugin = { ...A.pluginPulse(), layers: [{ move: 'glow', leds: 'all', for: 2146, colour: 5, level: 200 }] };   // a different one
  const engine = { kind: 'pulsetest', layout: 2, label: 'pulsetest 2.5 (engine 2)', show: packShow(show) };
  const look = stationLook({ family: 'pulse', drive: pulseDrive(engine.label), engine, profile });
  assert.equal(look.joins, true);
  const ds = new DriveShow(show);
  for (const t of times()) assert.deepEqual(look.at(t), ds.station(t), `${t} ms`);
  assert.notDeepEqual(look.at(1500), new DriveShow(defaultShow(pulse.DEFAULTS, profile)).station(1500));
});

test('the demo (no shared plug-in animation) plays its own start-up and look after its red wait', () => {
  const profile = defaultProfile('pulse');
  const show = demoShow([], pulse.DEFAULTS, profile);
  const engine = { kind: 'pulsetest', layout: 2, label: 'pulsetest 2.3 (engine 2)', show: packShow(show, { demo: true }) };
  const look = stationLook({ family: 'pulse', drive: pulseDrive(engine.label), engine, profile });
  assert.equal(look.joins, false);
  const own = new Show({ sections: [show.startup, show.ambient], drive: makeDrive(profile), colours: { red: pulse.DEFAULTS.red, orange: pulse.DEFAULTS.orange, white: pulse.DEFAULTS.white }, brightness: pulse.DEFAULTS.brightness });
  for (let t = OWN_FROM_MS.pulse; t < 20000; t += 13) assert.deepEqual(look.at(t), own.frame(t - OWN_FROM_MS.pulse), `${t} ms`);
  // an older engine, by its version: its bootloader introduces it
  assert.equal(stationLook({ family: 'pulse', drive: pulseDrive('pulsetest 1.4'), profile }).joins, false);
  assert.equal(stationLook({ family: 'pulse', drive: pulseDrive('pulsetest 2.5 (engine 2)'), profile }).joins, true);
});

test('a Core plays its own lighting from the drive\'s settings, on its 6 LEDs', () => {
  const profile = defaultProfile('core');
  const settings = { red: [0, 0, 255], orange: [0, 255, 0], brightness: 200 };
  const look = stationLook({ family: 'core', drive: { drive: 'C-0001', family: 'core', engine: { label: 'coretest 1.5' }, settings }, profile });
  assert.equal(look.joins, false);
  assert.equal(look.at(REPORT_MS.core + 500).length, 6);
  const plain = stationLook({ family: 'core', drive: { drive: 'C-0001', family: 'core', engine: { label: 'coretest 1.5' } }, profile });
  const differs = [1000, 3000, 6000, 9000].some((t) => JSON.stringify(look.at(t)) !== JSON.stringify(plain.at(t)));
  assert.ok(differs, 'the drive\'s own colours show');
  const C = core.DEFAULTS;
  const own = new Show({ sections: [A.coreEngine(C), A.coreDrift(C)], drive: makeDrive(profile), colours: { red: C.RED, orange: C.ORANGE, white: C.WHITE, yellow: C.YELLOW }, brightness: C.BRIGHTNESS });
  assert.deepEqual(plain.at(OWN_FROM_MS.core + 2500), own.frame(2500));
});

test('the steady look lights every LED of each board', () => {
  assert.deepEqual(steadyLeds('pulse', null).map(([n]) => n).sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(steadyLeds('core', null).map(([n]) => n).sort(), [1, 2, 3, 4, 5, 6]);
  for (const [, rgb, lvl] of steadyLeds('pulse', { red: [0, 0, 255], orange: [0, 255, 0], brightness: 128 })) {
    assert.equal(rgb.length, 3);
    assert.ok(lvl > 0 && lvl <= 1);
  }
});

test('casing models are read once and shared; with no library a model added is kept for the session', async () => {
  let lib = null;
  const models = new CasingModels(() => lib);
  await assert.rejects(models.open('sota.casing'), /choose the library folder/);
  assert.equal(models.has('sota.casing'), false, 'tried again next time');
  const fake = { name: 'SOTA', parts: [] };
  models.keep('sota.casing', fake, { forSession: true });
  assert.equal(await models.open('sota.casing'), fake);
  assert.deepEqual([...models.opened], ['sota.casing']);
  lib = new Library(new MemoryStore());
  await assert.rejects(models.open('other.casing'), /isn't in the library's casings folder/);
});
