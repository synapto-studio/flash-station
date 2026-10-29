// Roadmap task 7: the drive says what lighting it has (js/lighting.js). The fingerprint a 1.5
// drive sends, checked against the register: match, corrected, unknown (and a cut-off Pulse
// update), for Pulse and Core; and what a Pulse engine 2 plays, named by contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PulseImage, packSettings } from '../js/engines.js';
import { crc16 } from '../js/crc.js';
import { demoEngines, demoMoment, PULSE_DEFAULTS, CORE_DEFAULTS } from '../js/demo.js';
import { Library, MemoryStore } from '../js/library.js';
import { encodeCard } from '../js/idcard.js';
import { SimStation, SimDrive, SimCoreDrive } from '../js/sim-station.js';
import { Station, parseHello, coreSettingsPlan, coreHelloPlan } from '../js/station.js';
import { checkLighting, correctRegister, lightingText, fingerprintOf, whatItPlays, playsText, NO_ROUTINE } from '../js/lighting.js';
import { packShow, defaultShow } from '../js/show.js';
import * as A from '../js/animations.js';

const [CORE, PULSE, PULSE2] = demoEngines();
const GLACIER = { white: [200, 230, 255], red: [0, 90, 255], orange: [0, 200, 220] };
const routines = [
  { name: 'pulse-glacier.json', data: { type: 'routine', name: 'Glacier', family: 'pulse', phases: {}, shared: GLACIER } },
  { name: 'core-ember.json', data: { type: 'routine', name: 'Ember', family: 'core', phases: {}, shared: { brightness: 180 } } },
];
const palettes = [{ name: 'Neon', family: 'pulse', colours: { white: [220, 220, 255], red: [255, 0, 200], orange: [0, 230, 255] } }];
const lib = { engines: [CORE, PULSE, PULSE2], routines, palettes, library: new Library(new MemoryStore()) };
const ref = (e) => ({ label: e.label, file: e.fileName, kind: e.kind });

const pulseDrive = (settings, routine) => ({ drive: 'P-0001', family: 'pulse', number: 1, board: 'Pulse A2', engine: ref(PULSE), routine, settings, history: [] });
const coreDrive = (settings, routine) => ({ drive: 'C-0001', family: 'core', number: 1, board: 'Core A', engine: ref(CORE), routine, settings, history: [] });

// what a real drive sends, from the simulated drives (their own copy of the firmware's sums)
const pulseSays = (engine, settings) => {
  const d = new SimDrive(new PulseImage(engine.app, engine.version, settings, engine.show), encodeCard({ family: 'P', number: 1, board: 'Pulse A2' }));
  d.announces = d.tellsLighting = true;
  return parseHello(d.powerUp()).fingerprint;
};
const coreSays = (flashed, sent = null) => {
  const d = new SimCoreDrive(flashed, encodeCard({ family: 'C', number: 1, board: 'Core A' }));
  if (sent) d.feed(coreSettingsPlan(sent)[0].bytes);
  d.announces = d.tellsLighting = true;
  return parseHello(d.powerUp()).fingerprint;
};

test('fingerprints: what the app works out is what the simulated drive sends', () => {
  const glacier = { ...PULSE_DEFAULTS, ...GLACIER };
  assert.equal(fingerprintOf(PULSE, glacier), pulseSays(PULSE, glacier), 'Pulse: the trailer\'s app CRC');
  assert.equal(fingerprintOf(PULSE2, PULSE2.defaults), pulseSays(PULSE2, PULSE2.defaults), 'engine 2, show included');
  assert.equal(fingerprintOf(CORE, CORE_DEFAULTS), crc16(packSettings('SOTA.LED', CORE_DEFAULTS).subarray(8)), 'Core: the 98 bytes from the layout byte on');
  assert.equal(fingerprintOf(CORE, CORE_DEFAULTS), coreSays(CORE_DEFAULTS), 'flashed settings');
  const sent = { ...CORE_DEFAULTS, brightness: 180 };
  assert.equal(fingerprintOf(CORE, sent), coreSays(CORE_DEFAULTS, sent), 'sent settings win over the flashed ones');
  assert.notEqual(fingerprintOf(CORE, sent), fingerprintOf(CORE, CORE_DEFAULTS));
});

test('the show counts: another song moment changes an engine 2 drive\'s fingerprint', () => {
  const other = { ...PULSE2, show: packShow(defaultShow()) };
  assert.notEqual(fingerprintOf(other, PULSE2.defaults), fingerprintOf(PULSE2, PULSE2.defaults));
});

test('Pulse: match, corrected and unknown', async () => {
  const glacier = { ...PULSE_DEFAULTS, ...GLACIER };
  const match = await checkLighting(pulseDrive(glacier, 'Glacier'), pulseSays(PULSE, glacier), lib);
  assert.equal(match.status, 'match');
  assert.equal(lightingText(match), 'Glacier (checked with the drive)');

  // the register says glacier, the drive has the engine defaults (sent from another computer)
  const drive = pulseDrive(glacier, 'Glacier');
  const fixed = await checkLighting(drive, pulseSays(PULSE, PULSE_DEFAULTS), lib);
  assert.equal(fixed.status, 'corrected');
  assert.equal(correctRegister(drive, fixed), 'Register corrected: the drive has engine defaults, not glacier');
  assert.equal(drive.routine, null);
  assert.deepEqual(drive.settings, PULSE_DEFAULTS);
  assert.equal(lightingText(fixed), 'Engine defaults (checked with the drive; the register said glacier)');

  // a saved routine, and a colour set on top of the register's lighting
  const r = await checkLighting(pulseDrive(PULSE_DEFAULTS, null), pulseSays(PULSE, glacier), lib);
  assert.equal(r.name, 'Glacier');
  const neon = { ...PULSE_DEFAULTS, ...palettes[0].colours };
  const p = await checkLighting(pulseDrive(PULSE_DEFAULTS, null), pulseSays(PULSE, neon), lib);
  assert.equal(p.status, 'corrected');
  assert.equal(p.name, 'Engine defaults with the Neon colours');

  // another engine altogether: the register's engine is corrected too
  const d2 = pulseDrive(glacier, 'Glacier');
  const e2 = await checkLighting(d2, pulseSays(PULSE2, PULSE2.defaults), lib);
  assert.equal(e2.engine, PULSE2);
  assert.equal(correctRegister(d2, e2), `Register corrected: the drive has engine defaults on ${PULSE2.label}, not glacier on ${PULSE.label}`);
  assert.equal(d2.engine.file, PULSE2.fileName);

  const unknown = await checkLighting(pulseDrive(glacier, 'Glacier'), pulseSays(PULSE, { ...glacier, brightness: 201 }), lib);
  assert.equal(unknown.status, 'unknown');
  assert.equal(lightingText(unknown), 'Not what the register says. Send settings to set it.');

  const cut = await checkLighting(pulseDrive(glacier, 'Glacier'), NO_ROUTINE, lib);
  assert.equal(cut.status, 'unfinished');
  assert.match(lightingText(cut), /cut off\. Send the whole engine again/);
});

test('Pulse: a register engine file that isn\'t in the library can\'t be checked, and says so', async () => {
  const d = { ...pulseDrive(PULSE_DEFAULTS, null), engine: { label: 'pulsetest 1.12', file: 'pulsetest_1.12_app.hex', kind: 'pulsetest' } };
  const c = await checkLighting(d, 0x1234, lib);
  assert.equal(c.status, 'unknown');
  assert.equal(c.checked, false);
  assert.match(lightingText(c), /fingerprint 1234\): the register's engine file isn't in the engines folder/);
});

test('Core: match, corrected and unknown', async () => {
  const ember = { ...CORE_DEFAULTS, brightness: 180 };
  const match = await checkLighting(coreDrive(ember, 'Ember'), coreSays(CORE_DEFAULTS, ember), lib);
  assert.equal(match.status, 'match');
  assert.equal(lightingText(match), 'Ember (checked with the drive)');

  // the register thinks Ember was sent, but the drive forgot it (back on its flashed settings)
  const drive = { ...coreDrive(ember, 'Ember'), flashedSettings: CORE_DEFAULTS, flashedRoutine: null };
  const fixed = await checkLighting(drive, coreSays(CORE_DEFAULTS), lib);
  assert.equal(fixed.status, 'corrected');
  assert.equal(correctRegister(drive, fixed), 'Register corrected: the drive has engine defaults, not ember');
  assert.deepEqual(drive.settings, CORE_DEFAULTS);
  assert.ok(!('flashedSettings' in drive));

  // a saved routine the register doesn't know was sent
  const r = await checkLighting(coreDrive(CORE_DEFAULTS, null), coreSays(CORE_DEFAULTS, ember), lib);
  assert.equal(r.status, 'corrected');
  assert.equal(r.name, 'Ember');

  const unknown = await checkLighting(coreDrive(CORE_DEFAULTS, null), coreSays(CORE_DEFAULTS, { ...CORE_DEFAULTS, brightness: 7 }), lib);
  assert.equal(unknown.status, 'unknown');
});

test('Core: the hello answer (Find the drive) carries the fingerprint too', async () => {
  const sim = new SimStation(null, { version: '0.7' });
  const st = new Station(sim);
  await st.connect();
  const d = new SimCoreDrive(CORE_DEFAULTS, encodeCard({ family: 'C', number: 1, board: 'Core A' }));
  d.tellsLighting = true;
  sim.drive = d;
  const heard = parseHello(await st.ask(coreHelloPlan()[0]));
  assert.equal(heard.label, 'C-0001');
  assert.equal(heard.fingerprint, fingerprintOf(CORE, CORE_DEFAULTS));
});

test('what an engine plays, named by contents (the library\'s names first), not by the names inside it', () => {
  const moment = demoMoment();
  const p = whatItPlays(PULSE2, { moments: [moment] });
  assert.deepEqual(p.slots.map((s) => [s.label, s.name]), [['Start-up', 'Pulse start-up'], ['Ambient', 'Pulse ambient'], ['Plug-in', 'Plug-in'], ['Heartbeat', 'Heartbeat']]);
  assert.deepEqual(playsText(p).moments, 'Demo drop, plays Drop (example)');

  // the same recipe saved in the library under Jonny's own name wins
  const mine = { ...A.dropExample(), name: 'Big drop' };
  assert.equal(playsText(whatItPlays(PULSE2, { moments: [moment], animations: [mine] })).moments, 'Demo drop, plays Big drop');

  // a library file with the same name but other contents isn't it
  const changed = { ...A.pulseAmbient(), name: 'Pulse ambient', layers: A.pulseAmbient().layers.slice(1) };
  assert.equal(whatItPlays(PULSE2, { animations: [changed] }).slots[1].name, 'Pulse ambient', 'still today\'s look, by its bytes');

  // nothing in the library: the moment isn't known; the drop is still the built-in example
  assert.equal(playsText(whatItPlays(PULSE2, {})).moments, 'a song moment not in the library, plays Drop (example)');
  const odd = { ...PULSE2, show: packShow({ ...defaultShow(), ambient: { ...A.pulseAmbient(), layers: A.pulseAmbient().layers.slice(0, 2) } }) };
  assert.match(playsText(whatItPlays(odd, {})).anims, /Ambient: one not in the library \(\d+ bytes\)/);

  assert.equal(whatItPlays(PULSE, {}), null, 'engine 1 has no show');
  assert.equal(whatItPlays(CORE, {}), null);
});
