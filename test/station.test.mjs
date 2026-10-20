import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toHex } from '../js/intelhex.js';
import { readEngine, PulseImage, PULSE, packSettings } from '../js/engines.js';
import { crc16 } from '../js/crc.js';
import { demoEngines, PULSE_DEFAULTS, CORE_DEFAULTS } from '../js/demo.js';
import {
  testPlan, patchPlan, fullPlan, planMs, Station, wake,
  crc8, coreMessage, coreSettingsPayload, coreTestPlan, coreSettingsPlan, coreForgetPlan, coreHelloPlan,
  parseHello, helloAnswer, canListen, canProbe, PLUG_COPIES, canTellSocket, GONE, afterSend, unpluggedResult,
} from '../js/station.js';
import { encodeCard } from '../js/idcard.js';
import { SimStation, SimDrive, SimCoreDrive, SIM_LEVELS } from '../js/sim-station.js';

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
  assert.equal(st.version, '0.2');
  await assert.rejects(st.command('NOPE'), /refused/);
  await assert.rejects(st.command('SEND 5 1 AA 0'), /baud/);
  const queue = [...Buffer.from('HELLO\n')];
  const bad = new Station({ open: async () => {}, close: async () => {}, write: async () => {}, read: async () => Uint8Array.of(queue.shift() ?? 10) });
  await assert.rejects(bad.connect(), /isn't a Synapto station/);
});

test('choosing the station again: a WAIT answer from before is skipped, the hello still found', async () => {
  const sim = new SimStation(null);
  const st = new Station(sim);
  const write = sim.write.bind(sim);
  let first = true;
  sim.write = async (b) => {          // the box was still answering a WAIT from the last connection
    await write(b);
    if (first) { first = false; sim.rx.unshift(...Buffer.from('NONE\n')); }
  };
  await st.connect();
  assert.equal(st.version, '0.2');
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

// ---------------------------------------------------------------- coretest (Core)
const CORE_NEW = { ...CORE_DEFAULTS, brightness: 180, red: [255, 10, 0], whiteMs: 1500, breatheMs: 3000 };

test('Core link test for blue is exactly 5AA504010000FF6A, 3 copies at 100 baud, 2 stop bits, 300 ms gaps', () => {
  assert.deepEqual(steps(coreTestPlan([0, 0, 255])), Array(3).fill([100, 2, '5AA504010000FF6A', 300]));
  assert.equal(crc8([]), 0);
  assert.equal(crc8(Buffer.from('123456789')), 0xf4); // CRC-8 (poly 0x07, start 0) check value
});

test('Core settings message: 02 + the SOTA.LED block from its layout byte on + CRC-16 low byte first', () => {
  const block = packSettings('SOTA.LED', CORE_NEW).subarray(8);
  assert.equal(block.length, 98);
  const pay = coreSettingsPayload(CORE_NEW);
  assert.equal(pay.length, 101);
  assert.equal(pay[0], 2);
  assert.equal(hex(pay.subarray(1, 99)), hex(block));
  assert.equal(pay[99] | (pay[100] << 8), crc16(block));
  const msg = coreMessage(pay);
  assert.equal(msg.length, 105);
  assert.equal(hex(msg.subarray(0, 3)), '5AA565');
  assert.equal(msg[104], crc8(msg.subarray(2, 104)));
  const plan = coreSettingsPlan(CORE_NEW);
  assert.deepEqual(steps(plan), Array(3).fill([100, 2, hex(msg), 300]));
  const t = planMs(plan) / 1000;
  assert.ok(t > 35 && t < 37, `settings ${t} s`);
  assert.throws(() => coreSettingsPayload({ ...CORE_NEW, layout: 2 }), /layout 1 only/);
});

test('Core forget and hello messages', () => {
  assert.deepEqual(steps(coreForgetPlan()), Array(3).fill([100, 2, hex(coreMessage([3, 0x5a])), 300]));
  assert.deepEqual(steps(coreHelloPlan()), [[100, 2, hex(coreMessage([4])), 3500]]);
  assert.equal(hex(coreMessage([4])), `5AA50104${crc8([1, 4]).toString(16).toUpperCase().padStart(2, '0')}`);
});

test('Core link test: the simulated drive shows the colour and saves nothing', async () => {
  const drive = new SimCoreDrive(CORE_DEFAULTS);
  const { st, sim } = await station(drive);
  assert.ok((await st.run(coreTestPlan([9, 8, 7]))).completed);
  assert.deepEqual(drive.colour, [9, 8, 7]);
  assert.equal(drive.tests, 3);
  assert.equal(drive.eeWrites, 0);
  assert.equal(drive.source(), 'flash');
  assert.ok(sim.elapsedMs > 3000 && sim.elapsedMs < 4000);
});

test('Core settings send: saved once in EEPROM, the same again writes nothing, forget goes back to the flash', async () => {
  const drive = new SimCoreDrive(CORE_DEFAULTS);
  const { st, sim } = await station(drive);
  await st.run(coreSettingsPlan(CORE_NEW));
  assert.equal(drive.source(), 'eeprom');
  assert.deepEqual(drive.settings(), CORE_NEW);
  assert.equal(drive.heard, 3);
  assert.equal(drive.eeWrites, 1, 'copies that change nothing are ignored');
  assert.ok(sim.elapsedMs > 35000 && sim.elapsedMs < 37000);
  await st.run(coreSettingsPlan(CORE_NEW));
  assert.equal(drive.eeWrites, 1);
  await st.run(coreForgetPlan());
  assert.equal(drive.source(), 'flash');
  assert.deepEqual(drive.settings(), CORE_DEFAULTS);
  assert.equal(drive.eeWrites, 2, 'forget writes once; the later copies find nothing to forget');
  await st.run(coreHelloPlan());
  assert.equal(drive.hellos, 1);
});

// ---------------------------------------------------------------- station hello answer
const card = (number, board = 'Core A', family = 'C') => encodeCard({ family, number, board });

test('hello answer: 43 copies of 5A + ID card bytes 5-8 + CRC-8, read back as the drive', () => {
  const a = helloAnswer(card(258));
  assert.equal(a.length, 43 * 6);
  const one = [0x5a, 0x43, 0x02, 0x01, 0x10];
  assert.equal(hex(a.subarray(0, 6)), hex([...one, crc8(one.slice(1))]));
  assert.deepEqual(parseHello(a), { blank: false, copies: 43, number: 258, family: 'core', label: 'C-0258', board: 'Core A' });
  assert.deepEqual(parseHello(helloAnswer(null)), { blank: true, copies: 43 });
  assert.equal(parseHello(new Uint8Array(0)), null);
  assert.equal(parseHello(Uint8Array.of(0x5a, 0x43, 1, 0, 0x10, 0)), null, 'a bad CRC-8 is not an answer');
});

test('hello answer, 1.5 drives: the frame also carries the lighting fingerprint', () => {
  const a = helloAnswer(card(4, 'Pulse A2', 'P'), 3, 0x4112);
  assert.equal(a.length, 3 * 8);
  const body = [0x50, 0x04, 0x00, 0x22, 0x12, 0x41];
  assert.equal(hex(a.subarray(0, 8)), hex([0x5a, ...body, crc8(body)]));
  assert.deepEqual(parseHello(a), { blank: false, copies: 3, number: 4, family: 'pulse', label: 'P-0004', board: 'Pulse A2', fingerprint: 0x4112 });
  assert.deepEqual(parseHello(helloAnswer(null, 3, 0xffff)), { blank: true, copies: 3, fingerprint: 0xffff }, 'no ID card');
  assert.equal(parseHello(helloAnswer(card(4, 'Pulse A2', 'P'), 3, 0xffff)).fingerprint, 0xffff, 'no routine (an update was cut off)');
  // Fingerprints whose low byte happens to be the short frame's CRC-8 still read as the long frame.
  for (let fp = 0; fp < 0x10000; fp += 0x101) {
    const r = parseHello(helloAnswer(card(9), 34, fp));
    assert.equal(r.fingerprint, fp, `fingerprint ${fp.toString(16)}`);
    assert.equal(r.copies, 34);
  }
  // 1 in 65,536: low byte the short CRC-8 and high byte 5A. The ID still reads; its fingerprint is lost.
  const short = crc8([0x43, 0x09, 0x00, 0x10]);
  const tricky = parseHello(helloAnswer(card(9), 3, short | (0x5a << 8)));
  assert.deepEqual([tricky.label, tricky.copies], ['C-0009', 3]);
  // A short frame followed straight by its next copy is not read as a long one.
  assert.deepEqual(parseHello(helloAnswer(card(9), 3)), { blank: false, copies: 3, number: 9, family: 'core', label: 'C-0009', board: 'Core A' });
});

test('hello answer: noise and damaged copies are skipped, the copy heard most wins', () => {
  const good = helloAnswer(card(7));
  const noisy = Uint8Array.from([0x00, 0x5a, 0x5a, 0x13, ...good]);
  for (let i = 0; i < noisy.length; i += 17) noisy[i] ^= 0x08; // flipped bits here and there
  const r = parseHello(noisy);
  assert.equal(r.label, 'C-0007');
  assert.ok(r.copies > 20 && r.copies < 43, `${r.copies} copies`);
});

test('station 0.2 ASK: the simulated Core answers a hello with its ID card', async () => {
  const drive = new SimCoreDrive(CORE_DEFAULTS, card(12, 'Core B'));
  const { st, sim } = await station(drive);
  assert.equal(st.version, '0.2');
  assert.ok(canListen(st.version));
  const heard = await st.ask(coreHelloPlan()[0]);
  assert.equal(drive.hellos, 1);
  assert.equal(heard.length, 43 * 6, 'the 3.5 s listen hears all 3 s of the answer');
  assert.deepEqual(parseHello(heard), { blank: false, copies: 43, number: 12, family: 'core', label: 'C-0012', board: 'Core B' });
  assert.ok(sim.elapsedMs > 4000 && sim.elapsedMs < 4500, 'about 4 s: 0.55 s of hello, 3.5 s of listening');
  // A settings message is not a hello: nothing comes back.
  assert.equal((await st.ask(coreForgetPlan()[0])).length, 0);
});

test('ASK with no drive or a Pulse in the socket hears nothing; station 0.1 refuses ASK', async () => {
  assert.equal(parseHello(await (await station(null)).st.ask(coreHelloPlan()[0])), null);
  assert.equal(parseHello(await (await station(new SimDrive(oldImage()))).st.ask(coreHelloPlan()[0])), null);
  const old = new Station(new SimStation(null, { version: '0.1' }));
  await old.connect();
  assert.equal(canListen(old.version), false);
  await assert.rejects(old.ask(coreHelloPlan()[0]), /refused/);
  assert.equal(canListen('0.10'), true);
  assert.equal(canListen('1.0'), true);
  assert.equal(canListen(null), false);
});

// ---------------------------------------------------------------- plug-in (station WAIT)
test('WAIT: a drive that introduces itself is reported with 3 copies of its ID card', async () => {
  const { st, sim } = await station(null);
  const drive = new SimCoreDrive(CORE_DEFAULTS, card(31));
  drive.announces = true;
  const pending = st.wait(5000);
  setTimeout(() => sim.plugIn(drive), 20);
  const t0 = Date.now();
  const heard = await pending;
  assert.ok(Date.now() - t0 < 1000, 'reported as soon as it is plugged in');
  assert.equal(heard.length, PLUG_COPIES * 6);
  assert.deepEqual(parseHello(heard), { blank: false, copies: 3, number: 31, family: 'core', label: 'C-0031', board: 'Core A' });
});

test('WAIT: nothing plugged in gives NONE; a plug-in between WAITs is kept for the next one', async () => {
  const { st, sim } = await station(null);
  assert.equal(await st.wait(30), null);
  const pulse = new SimDrive(oldImage(), card(4, 'Pulse A2', 'P'));
  pulse.announces = true;
  sim.plugIn(pulse);
  const r = parseHello(await st.wait(30));
  assert.equal(r.label, 'P-0004');
  assert.equal(r.family, 'pulse');
  assert.equal(await st.wait(30), null, 'reported once');
});

test("WAIT: a drive on today's engines is reported but says nothing; one with no card says FF FF FF FF", async () => {
  const { st, sim } = await station(null);
  sim.plugIn(new SimCoreDrive(CORE_DEFAULTS, card(1)));
  const quiet = await st.wait(30);
  assert.equal(quiet.length, 0);
  assert.equal(parseHello(quiet), null);
  const blank = new SimCoreDrive(CORE_DEFAULTS, null);
  blank.announces = true;
  sim.plugIn(blank);
  assert.deepEqual(parseHello(await st.wait(30)), { blank: true, copies: 3 });
});

test('a send asked for during a WAIT goes after it, not into it', async () => {
  const { st, sim } = await station(null);
  const drive = new SimCoreDrive(CORE_DEFAULTS, card(2));
  const waiting = st.wait(60);
  const sent = st.run(coreTestPlan([1, 2, 3]));
  sim.drive = drive;
  assert.equal(await waiting, null);
  assert.ok((await sent).completed);
  assert.equal(drive.tests, 3);
  const old = new Station(new SimStation(null, { version: '0.1' }));
  await old.connect();
  await assert.rejects(old.wait(30), /refused/);
});

test('Core: a damaged copy is dropped by its CRC-8 and the next copy gets through', () => {
  const drive = new SimCoreDrive(CORE_DEFAULTS);
  const plan = coreSettingsPlan(CORE_NEW);
  const bad = Uint8Array.from(plan[0].bytes);
  bad[40] ^= 0x10;
  drive.feed(bad);
  assert.equal(drive.heard, 0);
  assert.equal(drive.source(), 'flash');
  drive.feed(plan[1].bytes);
  assert.equal(drive.source(), 'eeprom');
  assert.deepEqual(drive.settings(), CORE_NEW);
});

test('Core refuses a wrong layout byte or settings CRC-16 even when the CRC-8 is right, and ignores pulsetest', () => {
  const drive = new SimCoreDrive(CORE_DEFAULTS);
  const wrongLayout = Uint8Array.from(coreSettingsPayload(CORE_NEW));
  wrongLayout[1] = 2;
  const c = crc16(wrongLayout.subarray(1, 99));
  wrongLayout[99] = c & 0xff;
  wrongLayout[100] = c >> 8;
  const wrongCrc = Uint8Array.from(coreSettingsPayload(CORE_NEW));
  wrongCrc[99] ^= 1;
  for (const p of [wrongLayout, wrongCrc]) drive.feed(coreMessage(p));
  assert.equal(drive.heard, 2);
  for (const s of patchPlan(newImage())) drive.feed(s.bytes);
  assert.equal(drive.eeWrites, 0);
  assert.equal(drive.source(), 'flash');
});

// ---------------------------------------------------------------- station 0.3: the socket
async function station3(drive) {
  const sim = new SimStation(drive, { version: '0.3' });
  const st = new Station(sim);
  await st.connect();
  return { sim, st };
}
const pulseRecord = () => ({ drive: 'P-0001', family: 'pulse', board: 'Pulse A2', settings: { ...PULSE_DEFAULTS }, routine: 'original',
  engine: { label: 'pulsetest 1.4', file: 'pulsetest_1.4_app.hex', kind: 'pulsetest' }, history: [] });

test('station 0.3: SOCKET says whether a drive is in; 0.2 has no SOCKET', async () => {
  const { st, sim } = await station3(null);
  assert.ok(canTellSocket(st.version));
  assert.equal(await st.socket(), false);
  sim.plugIn(new SimDrive(oldImage()));
  assert.equal(await st.socket(), true);
  const { st: old } = await station(null);
  assert.equal(canTellSocket(old.version), false);
  assert.equal(canTellSocket('0.10'), true);
  await assert.rejects(old.socket(), /refused/);
});

test('station 0.3: a send to an empty socket is refused by the box, and the register keeps its lighting', async () => {
  const { st } = await station3(null);
  const plan = patchPlan(newImage());
  const r = await st.run(plan);
  assert.deepEqual([r.completed, r.empty, r.failed], [false, true, 0]);
  const drive = pulseRecord();
  const before = JSON.stringify(drive);
  const after = afterSend(drive, r, { plan, settings: newImage().settings, routine: 'glacier' });
  assert.equal(after.result, 'Unplugged after 0 s, nothing changed');
  assert.equal(JSON.stringify(drive), before, 'lighting, routine and engine as they were');
  assert.equal(await st.ask(coreHelloPlan()[0]), null, 'ASK to an empty socket: OK EMPTY');
});

test('station 0.3: a Pulse unplugged mid-send leaves the register as it was; the history says what the drive may have', async () => {
  const pulse = new SimDrive(oldImage());
  const { st, sim } = await station3(pulse);
  const plan = patchPlan(newImage());
  // Unplugged after the wake-up call: nothing reached the drive's flash.
  let r = await st.run(plan, { onProgress: ({ step }) => { if (step === plan[0]) sim.unplug(); } });
  assert.deepEqual([r.empty, r.failed], [true, 1]);
  assert.equal(pulse.pageWrites, 0);
  const drive = pulseRecord(), before = JSON.stringify(drive);
  assert.equal(afterSend(drive, r, { plan, settings: newImage().settings, routine: 'glacier' }).result, 'Unplugged after 5 s, nothing changed');
  assert.equal(JSON.stringify(drive), before);
  assert.equal(await st.wait(30), GONE, 'WAIT reports the unplug');
  assert.equal(await st.wait(30), null, '...once');
  // Unplugged after the first settings page went out: unfinished, it waits for the rest.
  sim.plugIn(pulse);
  await st.wait(30);
  r = await st.run(plan, { onProgress: ({ step }) => { if (step === plan[2]) sim.unplug(); } });
  assert.deepEqual([r.empty, r.failed], [true, 3]);
  assert.equal(pulse.valid, false, 'the simulated drive did start changing');
  const a = afterSend(drive, r, { plan, settings: newImage().settings, routine: 'glacier' });
  assert.equal(a.got, 'unfinished');
  assert.match(a.result, /^Unplugged after 6 s: it may be unfinished/);
  assert.equal(JSON.stringify(drive), before, 'still the old lighting in the register');
  assert.equal(unpluggedResult(testPlan([1, 2, 3]), 50), 'nothing', 'a link test changes nothing');
});

test('station 0.3: a Core unplugged after a settings copy may have the new lighting', async () => {
  const core = new SimCoreDrive(CORE_DEFAULTS, card(3));
  const { st, sim } = await station3(core);
  const changed = { ...CORE_DEFAULTS, brightness: 40 };
  const plan = coreSettingsPlan(changed);
  const r = await st.run(plan, { onProgress: ({ step }) => { if (step === plan[0]) sim.unplug(); } });
  assert.deepEqual([r.empty, r.failed], [true, 1]);
  assert.equal(unpluggedResult(plan, r.failed), 'maybe');
  assert.equal(unpluggedResult(coreTestPlan([1, 2, 3]), 2), 'nothing');
  const drive = { drive: 'C-0003', family: 'core', settings: { ...CORE_DEFAULTS }, routine: null, history: [] };
  assert.match(afterSend(drive, r, { plan, settings: changed }).result, /it may have the new lighting/);
  assert.deepEqual(drive.settings, CORE_DEFAULTS);
});

test('station 0.3: a drive left in all the way gets plain OKs; LEVELS after a plug-in', async () => {
  const { st, sim } = await station3(null);
  assert.equal(await st.levels(), null, 'LEVELS NONE before the first plug-in');
  const pulse = new SimDrive(oldImage(), card(4, 'Pulse A2', 'P'));
  pulse.announces = true;
  sim.plugIn(pulse);
  assert.equal(parseHello(await st.wait(30)).label, 'P-0004');
  const lv = await st.levels();
  assert.deepEqual(Object.values(lv), SIM_LEVELS.split(' ').slice(1).map(Number));
  const r = await st.run(patchPlan(newImage()));
  assert.ok(r.completed && !r.empty);
  assert.deepEqual(pulse.settings(), { ...PULSE_DEFAULTS, ...NEW });
  const drive = pulseRecord();
  assert.equal(afterSend(drive, r, { plan: patchPlan(newImage()), settings: newImage().settings, routine: 'glacier' }).result, 'Done');
  assert.equal(drive.routine, 'glacier');
});

test('station 0.2 still works: no SOCKET, sends to an empty socket answer OK as before, unplugs are not reported', async () => {
  const { st, sim } = await station(new SimDrive(oldImage()));
  sim.unplug();
  const r = await st.run(testPlan([1, 2, 3]));
  assert.ok(r.completed);
  assert.equal(await st.wait(30), null);
});

test('station 0.6: PROBE measures the socket (empty vs a drive in)', async () => {
  const empty = new Station(new SimStation(null, { version: '0.6' }));
  await empty.connect();
  assert.deepEqual(await empty.probe(), { full: 61, min: 4, avg: 6, max: 9, end: 6 });
  const st = new Station(new SimStation(new SimDrive(oldImage()), { version: '0.6' }));
  await st.connect();
  assert.equal((await st.probe()).end, 1030);
  assert.ok(canProbe('0.6') && !canProbe('0.5'));
});
