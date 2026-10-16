import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHex } from '../js/intelhex.js';
import { readEngine, PulseImage, PULSE } from '../js/engines.js';
import { demoEngines, PULSE_DEFAULTS } from '../js/demo.js';
import { testPlan, patchPlan, fullPlan, planMs, Station, wake } from '../js/station.js';
import { SimStation, SimDrive } from '../js/sim-station.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'fs-station-'));
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();
const steps = (plan) => plan.map((s) => [s.baud, s.stopBits, hex(s.bytes), s.gapMs]);

const engine = demoEngines().find((e) => e.kind === 'pulsetest');
const appMem = new Map();
engine.app.forEach((b, i) => appMem.set(0x0c00 + i, b));
const appHex = join(TMP, 'app.hex');
writeFileSync(appHex, toHex(appMem));

const python = (args) => JSON.parse(execFileSync('python3', [join(HERE, 'ref_pulse_station.py'), 'plan', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }));
const NEW = { riseMs: 1500, white: [1, 2, 3], micTrimDb: -3 };
const pySets = ['riseMs=1500', 'white=1,2,3', 'micTrimDb=-3'];
const oldImage = () => new PulseImage(engine.app, engine.version);
const newImage = () => new PulseImage(engine.app, engine.version, { ...PULSE_DEFAULTS, ...NEW });

test('link test frames match the reference byte for byte', () => {
  assert.deepEqual(steps(testPlan([10, 20, 30])), python(['test', '10', '20', '30']));
});
test('settings plan matches the reference byte for byte', () => {
  assert.deepEqual(steps(patchPlan(newImage())), python(['patch', appHex, ...pySets]));
});
test('whole-engine plan matches the reference byte for byte', () => {
  assert.deepEqual(steps(fullPlan(newImage())), python(['full', appHex, ...pySets]));
});

test('plans take about as long as the Pi tool: ~23 s, ~15 s, minutes', () => {
  const t = planMs(testPlan([1, 1, 1])) / 1000, p = planMs(patchPlan(newImage())) / 1000, f = planMs(fullPlan(newImage())) / 1000;
  assert.ok(t > 21 && t < 26, `link test ${t}`);
  assert.ok(p > 13 && p < 17, `settings ${p}`);
  assert.ok(f > 240 && f < 420, `engine ${f}`);
  assert.equal(wake(5000).length, 500);
});

async function station(drive) {
  const sim = new SimStation(drive);
  const st = new Station(sim);
  await st.connect();
  return { sim, st };
}

test('station: HELLO, bad commands and bad SENDs are explained', async () => {
  const { st } = await station(null);
  assert.equal(st.version, '0.1');
  await assert.rejects(st.command('NOPE'), /refused/);
  await assert.rejects(st.command('SEND 5 1 AA 0'), /baud/);
  const queue = [...Buffer.from('HELLO\n')];
  const bad = new Station({ open: async () => {}, close: async () => {}, write: async () => {}, read: async () => Uint8Array.of(queue.shift() ?? 10) });
  await assert.rejects(bad.connect(), /isn't a Synapto station/);
});

test('a late reply from a timed-out command is not taken as the next answer', async () => {
  const { st } = await station(null);
  st.transport.rx.push(...Buffer.from('OK\n')); // the box answered a SEND after the app gave up
  assert.match(await st.command('HELLO'), /^SYNAPTO-STATION/);
});

test('link test shows the colour and saves nothing', async () => {
  const drive = new SimDrive(oldImage());
  const before = hex(drive.app());
  const { st } = await station(drive);
  const r = await st.run(testPlan([9, 8, 7]));
  assert.ok(r.completed);
  assert.deepEqual(drive.colour, [9, 8, 7]);
  assert.equal(drive.tests, 110);
  assert.equal(drive.pageWrites, 0);
  assert.equal(hex(drive.app()), before);
});

test('settings send: simulated drive ends with the new settings page and a valid trailer', async () => {
  const drive = new SimDrive(oldImage());
  const { st, sim } = await station(drive);
  await st.run(patchPlan(newImage()));
  assert.equal(drive.valid, true);
  assert.equal(drive.imageValid(), true);
  assert.deepEqual(drive.settings(), { ...PULSE_DEFAULTS, ...NEW });
  assert.equal(drive.pageWrites, 2, 'only the settings page and the trailer change, once');
  const want = newImage();
  for (const [p, d] of want.pages()) assert.equal(hex(drive.pages.get(p)), hex(d), `page ${p}`);
  assert.ok(sim.elapsedMs > 13000 && sim.elapsedMs < 17000);
});

test('settings send is refused by a drive running different code', async () => {
  const other = demoEngines().find((e) => e.kind === 'pulsetest');
  const app = Uint8Array.from(other.app);
  app[5000] ^= 0xff;
  const drive = new SimDrive(new PulseImage(app, [1, 0]));
  const { st } = await station(drive);
  await st.run(patchPlan(newImage()));
  assert.equal(drive.pageWrites, 0);
  assert.deepEqual(drive.settings(), PULSE_DEFAULTS);
  assert.equal(drive.valid, true);
});

test('whole-engine send replaces everything and ends valid', async () => {
  const app = Uint8Array.from(engine.app);
  for (let i = 3000; i < 3400; i++) app[i] ^= 0x5a;
  const drive = new SimDrive(new PulseImage(app, [0, 9]));
  const { st } = await station(drive);
  await st.run(fullPlan(newImage()));
  assert.equal(drive.valid, true);
  assert.deepEqual(drive.settings(), { ...PULSE_DEFAULTS, ...NEW });
  for (const [p, d] of newImage().pages()) assert.equal(hex(drive.pages.get(p)), hex(d), `page ${p}`);
});

test('an interrupted engine send leaves the drive marked unfinished, never half-valid', async () => {
  const app = Uint8Array.from(engine.app);
  for (let i = 3000; i < 3400; i++) app[i] ^= 0x5a;
  const drive = new SimDrive(new PulseImage(app, [0, 9]));
  const { st } = await station(drive);
  const plan = fullPlan(newImage());
  let n = 0;
  const r = await st.run(plan, { shouldStop: () => ++n > 120 });
  assert.equal(r.completed, false);
  assert.ok(drive.pageWrites > 0);
  assert.equal(drive.valid, false);
  await st.run(plan); // sending again finishes the job
  assert.equal(drive.valid, true);
});

test('a damaged frame is rejected by its CRC, and the next copy still gets through', () => {
  const drive = new SimDrive(oldImage());
  const plan = patchPlan(newImage());
  const bad = plan.slice(0, 4).map((s) => Uint8Array.from(s.bytes));
  bad[2][20] ^= 1; // settings page of copy 1
  for (const b of bad) drive.feed(b);
  assert.equal(drive.rejected > 0, true);
  assert.equal(drive.valid, false, 'left unfinished until a good copy lands');
  for (const s of plan.slice(4)) drive.feed(s.bytes);
  assert.equal(drive.valid, true);
  assert.deepEqual(drive.settings(), { ...PULSE_DEFAULTS, ...NEW });
});
