// The Flash Station (the XIAO box): frames and plans for pulsetest and coretest drives, and
// the client that sends them through the box's USB serial commands. Formats are in
// docs/STATION-PROTOCOL.md; test/ref_pulse_station.py builds the same pulsetest bytes
// independently.
//
// A plan is a list of steps { bytes, gapMs, baud, stopBits, note }. Each step is one SEND:
// the box dips the drive's 5 V for the bits, then holds full supply for gapMs.

import { crc16 } from './crc.js';
import { PULSE, packSettings } from './engines.js';
import { BOARDS, driveLabel } from './idcard.js';

export const BAUD = 1000;
const TEST_REPEATS = 110; // 0.1 s gaps + 80 ms a frame: about 20 s

// ---------------------------------------------------------------- frames
export function frame(type, payload) {
  const body = Uint8Array.from([type, payload.length, ...payload]);
  const out = new Uint8Array(body.length + 4);
  out.set([0x5a, 0xa5]);
  out.set(body, 2);
  const c = crc16(body);
  out[out.length - 2] = c & 0xff;
  out[out.length - 1] = c >> 8;
  return out;
}

// 0xF0 bytes back to back at 1000 baud: a 100 Hz square wave, 10 ms a byte.
export function wake(ms) {
  return new Uint8Array(Math.round(ms / 10)).fill(0xf0);
}

const u16 = (v) => [v & 0xff, v >> 8];

export function headerFrame(img, { patch, pages }) {
  const mask = new Uint8Array(26);
  for (const p of pages) mask[p >> 3] |= 1 << (p & 7);
  const payload = [
    ...u16(img.imageId()), patch ? 1 : 0, ...u16(img.app.length), ...u16(crc16(img.app)),
    ...u16(img.codeCrc()), img.setPage, ...mask,
  ];
  return frame(0x48, payload); // 'H'
}

export function pageFrame(img, { patch, index, data }) {
  return frame(0x50, [...u16(img.imageId()), patch ? 1 : 0, index, ...data]); // 'P'
}

export function testFrame(r, g, b) {
  return frame(0x54, [r, g, b]); // 'T'
}

// ---------------------------------------------------------------- plans
const step = (bytes, gapMs = 0, note = '', baud = BAUD, stopBits = 1) => ({ bytes, gapMs, baud, stopBits, note });

export function testPlan([r, g, b]) {
  const f = testFrame(r, g, b);
  return [step(wake(3000), 0, 'Wake-up call')].concat(Array.from({ length: TEST_REPEATS }, () => step(f, 100, 'Link test')));
}

export function patchPlan(img) {
  const pages = new Map(img.pages());
  const header = headerFrame(img, { patch: true, pages: [img.setPage, PULSE.TRAILER_PAGE] });
  const settings = pageFrame(img, { patch: true, index: img.setPage, data: pages.get(img.setPage) });
  const trailer = pageFrame(img, { patch: true, index: PULSE.TRAILER_PAGE, data: pages.get(PULSE.TRAILER_PAGE) });
  const steps = [step(wake(5000), 0, 'Wake-up call')];
  for (let copy = 0; copy < 4; copy++) {
    if (copy) steps.push(step(wake(400), 0, 'Wake-up call'));
    steps.push(step(header, 150, `Settings, copy ${copy + 1} of 4`), step(settings, 30), step(trailer, 30));
  }
  return steps;
}

export function fullPlan(img) {
  const pages = img.pages();
  const all = pages.map(([p]) => p);
  const header = headerFrame(img, { patch: false, pages: all });
  const steps = [step(wake(5000), 0, 'Wake-up call')];
  let first = true;
  for (let pass = 1; pass <= 2; pass++) {
    pages.forEach(([index, data], n) => {
      if (n % 8 === 0) {
        if (!first) steps.push(step(wake(400), 0, 'Wake-up call'));
        steps.push(step(header, 150, `Engine, pass ${pass} of 2`));
      }
      first = false;
      steps.push(step(pageFrame(img, { patch: false, index, data }), 30));
    });
  }
  return steps;
}

// ---------------------------------------------------------------- coretest (Core)
// coretest 1.3's receiver: 100 baud, 2 stop bits, no wake-up call. A message is
// 5A A5 len payload crc8, sent 3 times with 300 ms gaps (one SEND a copy).
export const CORE_BAUD = 100;
const CORE_COPIES = 3;
const CORE_GAP_MS = 300;
const CORE_LAYOUT = 1; // the SOTA.LED layout coretest 1.3's receiver takes

// CRC-8, polynomial 0x07, start 0.
export function crc8(bytes, c = 0) {
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export function coreMessage(payload) {
  const body = Uint8Array.from([payload.length, ...payload]);
  return Uint8Array.from([0x5a, 0xa5, ...body, crc8(body)]);
}

// 02 + the SOTA.LED block from its layout byte on (98 bytes) + their CRC-16, low byte first.
export function coreSettingsPayload(settings) {
  const block = packSettings('SOTA.LED', settings).subarray(8);
  if (block[0] !== CORE_LAYOUT) throw new Error(`These settings use layout ${block[0]}; coretest 1.3 takes layout ${CORE_LAYOUT} only.`);
  const c = crc16(block);
  return Uint8Array.from([0x02, ...block, c & 0xff, c >> 8]);
}

const coreStep = (bytes, gapMs, note) => step(bytes, gapMs, note, CORE_BAUD, 2);
const coreCopies = (msg, note) =>
  Array.from({ length: CORE_COPIES }, (_, i) => coreStep(msg, CORE_GAP_MS, `${note}, copy ${i + 1} of ${CORE_COPIES}`));

export const coreTestPlan = ([r, g, b]) => coreCopies(coreMessage([0x01, r, g, b]), 'Link test');
export const coreSettingsPlan = (settings) => coreCopies(coreMessage(coreSettingsPayload(settings)), 'Settings');
export const coreForgetPlan = () => coreCopies(coreMessage([0x03, 0x5a]), 'Forget sent settings');
// Sent once; the long gap keeps the line full while the drive flickers its answer (3 s).
export const coreHelloPlan = () => [coreStep(coreMessage([0x04]), 3500, 'Station hello')];

// ---------------------------------------------------------------- station hello (drive → station)
// The drive flickers its LEDs at 1000 baud, 8N1: 5A, ID card bytes 5-8 (family, drive number
// low, high, board code), CRC-8 of those 4 bytes; 43 copies in 3 s. The station turns the
// flicker back into bytes (ASK); the app finds the copies here and takes the one heard most.
export function parseHello(bytes) {
  // A frame is 5A, ID card bytes 5-8, CRC-8 of those 4 (coretest 1.4, pulsetest 1.4), or 5A, the
  // 4 ID bytes, the drive's 2-byte lighting fingerprint (low byte first), CRC-8 of those 6
  // (pulsetest 1.5, coretest 1.5). Same choice as the station's idCopies when both fit.
  const seen = new Map();
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] !== 0x5a) continue;
    const shortOk = crc8(bytes.slice(i + 1, i + 5)) === bytes[i + 5];
    let longOk = i + 7 < bytes.length && crc8(bytes.slice(i + 1, i + 7)) === bytes[i + 7];
    if (longOk && shortOk && bytes[i + 6] === 0x5a) longOk = false;   // both fit (1 in 256): a short one, the next copy after it
    if (!longOk && !shortOk) continue;
    const n = longOk ? 6 : 4;
    const key = hex(bytes.slice(i + 1, i + 1 + n));
    seen.set(key, (seen.get(key) || 0) + 1);
    i += n + 1;
  }
  if (!seen.size) return null;
  const [key, copies] = [...seen].sort((a, b) => b[1] - a[1])[0];
  const id = Uint8Array.from(key.match(/../g), (x) => parseInt(x, 16));
  const fp = id.length === 6 ? { fingerprint: id[4] | (id[5] << 8) } : {};
  if (id.subarray(0, 4).every((b) => b === 0xff)) return { blank: true, copies, ...fp };
  const family = String.fromCharCode(id[0]);
  const number = id[1] | (id[2] << 8);
  return {
    blank: false, copies, number,
    family: { C: 'core', P: 'pulse' }[family] || family,
    label: driveLabel(family, number),
    board: BOARDS[id[3]] ? BOARDS[id[3]].code : `board ${id[3]}`,
    ...fp,
  };
}

// The bytes a drive with this ID card flickers back (see parseHello): 43 copies after a
// station hello (34 from coretest 1.5, whose frame is longer), 3 when it introduces itself on
// plug-in. With a fingerprint (a number), the 1.5 frame that carries it.
export const HELLO_COPIES = 43;
export const PLUG_COPIES = 3;
export function helloAnswer(card, copies = HELLO_COPIES, fingerprint = null) {
  let id = card ? card.subarray(5, 9) : Uint8Array.of(0xff, 0xff, 0xff, 0xff);
  if (fingerprint != null) id = Uint8Array.of(...id, fingerprint & 0xff, fingerprint >> 8);
  const one = [0x5a, ...id, crc8(id)];
  return Uint8Array.from(Array.from({ length: copies }, () => one).flat());
}

const versionAtLeast = (version, minor) => {
  const v = /^(\d+)\.(\d+)/.exec(version || '');
  return !!v && Number(v[1]) * 1000 + Number(v[2]) >= minor;
};
// Station firmware that has ASK and WAIT (0.2 on) can read a drive's answer.
export const canListen = (version) => versionAtLeast(version, 2);
// Station firmware that knows when its socket is empty (0.3 on): SOCKET, LEVELS, WAIT's GONE,
// and OK EMPTY from a SEND or ASK that found nobody there.
export const canTellSocket = (version) => versionAtLeast(version, 3);
// What wait() returns when the drive in the socket has been unplugged (0.3 on).
export const GONE = 'gone';

// What the drive got from a plan that stopped because it was unplugged (OK EMPTY at step
// `failed`; every step before it was answered OK, so the drive heard it). Pulse: once a
// page has gone out the drive is marked unfinished and waits for the rest. Core: a whole
// settings or forget copy may already have landed.
export function unpluggedResult(plan, failed) {
  const done = plan.slice(0, failed);
  const isFrame = (b) => b[0] === 0x5a && b[1] === 0xa5;
  if (done.some((s) => s.baud === BAUD && isFrame(s.bytes) && s.bytes[2] === 0x50)) return 'unfinished';
  if (done.some((s) => s.baud === CORE_BAUD && isFrame(s.bytes) && (s.bytes[3] === 0x02 || s.bytes[3] === 0x03))) return 'maybe';
  return 'nothing';
}

export const stepMs = (s) => Math.round((s.bytes.length * (9 + s.stopBits) * 1000) / s.baud) + s.gapMs;
export const planMs = (plan) => plan.reduce((n, s) => n + stepMs(s), 0);

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`;
}

// ---------------------------------------------------------------- the register after a send
// What a plan that finished, was stopped or met an empty socket means for the drive's
// register entry. Changes drive in place only when the plan completed; returns the history
// line's result (and, after an unplug, what the drive may have got: see unpluggedResult).
//   settings: what the plan sent (null for a link test, forget or hello)
//   routine: the routine's name, null for engine defaults, undefined to leave it as it is
//   engine: { label, file, kind } of a whole engine that was sent, else null
//   forget: a Core went back to its flashed settings
export function afterSend(drive, r, { plan, settings = null, routine, engine = null, forget = false }) {
  if (r.empty) {
    const after = `Unplugged after ${formatDuration(r.sent)}`;
    const got = unpluggedResult(plan, r.failed);
    const result = got === 'unfinished' ? `${after}: it may be unfinished (it waits red for the rest)`
      : got === 'maybe' ? `${after}: it may have the new lighting` : `${after}, nothing changed`;
    return { result, got };
  }
  if (!r.completed) return { result: 'Stopped before the end' };
  if (settings) {
    // A Core keeps its flashed settings under the sent ones; remember them for "forget".
    if (drive.family === 'core' && !drive.flashedSettings) {
      drive.flashedSettings = drive.settings;
      drive.flashedRoutine = drive.routine;
    }
    drive.settings = settings;
  }
  if (forget) {
    if (drive.flashedSettings) {
      drive.settings = drive.flashedSettings;
      drive.routine = drive.flashedRoutine ?? null;
    }
    delete drive.flashedSettings;
    delete drive.flashedRoutine;
  }
  if (engine) drive.engine = engine;
  if (routine !== undefined) drive.routine = routine;
  return { result: 'Done' };
}

// ---------------------------------------------------------------- the box
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

export class StationError extends Error {}

export class Station {
  constructor(transport) {
    this.transport = transport;
    this.version = null;
    this.queue = Promise.resolve(); // one command at a time: a WAIT and a SEND never overlap
  }

  async connect() {
    await this.transport.open({ baudRate: 115200 }); // the box ignores the speed
    try {
      return await this.hello();
    } catch (e) {
      await this.transport.close();
      throw e;
    }
  }

  async close() {
    await this.transport.close();
  }

  async readLine(timeoutMs) {
    const end = Date.now() + timeoutMs;
    let line = '';
    while (Date.now() < end) {
      const b = await this.transport.read(1, Math.max(1, end - Date.now()));
      if (!b.length) continue;
      if (b[0] === 10) return line.trim();
      line += String.fromCharCode(b[0]);
    }
    throw new StationError('The station stopped answering. Check its USB cable, then connect again.');
  }

  command(line, timeoutMs = 3000) {
    const run = this.queue.then(() => this.exchange(line, timeoutMs));
    this.queue = run.catch(() => {});
    return run;
  }

  async exchange(line, timeoutMs) {
    // A reply that arrived after an earlier timeout must not be taken as this one's answer.
    if (this.transport.discard) this.transport.discard();
    await this.transport.write(new TextEncoder().encode(`${line}\n`));
    const reply = await this.readLine(timeoutMs);
    if (reply.startsWith('ERR')) throw new StationError(`The station refused that: ${reply.slice(3).trim() || 'no reason given'}`);
    return reply;
  }

  async hello() {
    let reply = await this.command('HELLO');
    // Choosing the station again while it was answering a WAIT: that answer (NONE) can still
    // arrive first, so look a few lines further for the hello.
    for (let i = 0; i < 3 && !reply.startsWith('SYNAPTO-STATION'); i++) reply = await this.readLine(1500).catch(() => '');
    if (!reply.startsWith('SYNAPTO-STATION')) {
      throw new StationError("That port isn't a Synapto station. Pick the XIAO box's port instead.");
    }
    this.version = reply.slice('SYNAPTO-STATION'.length).trim();
    return reply;
  }

  // Sends one step. False if the box found the socket empty at some point during it (0.3 on).
  async send(s) {
    const wait = stepMs(s) + 3000;
    const reply = await this.command(`SEND ${s.baud} ${s.stopBits} ${hex(s.bytes)} ${s.gapMs}`, wait);
    if (reply === 'OK EMPTY') return false;
    if (reply !== 'OK') throw new StationError(`Unexpected answer from the station: ${reply}`);
    return true;
  }

  // Sends one step like send(), but listens on the sense wire during its gap and returns the
  // bytes the drive flickered back (empty if it said nothing; null if the socket was empty).
  async ask(s) {
    const wait = stepMs(s) + 3000;
    const reply = await this.command(`ASK ${s.baud} ${s.stopBits} ${hex(s.bytes)} ${s.gapMs}`, wait);
    if (reply === 'OK EMPTY') return null;
    const m = /^HEARD(?:\s+([0-9A-Fa-f]*))?$/.exec(reply);
    if (!m) throw new StationError(`Unexpected answer from the station: ${reply}`);
    return Uint8Array.from((m[1] || '').match(/../g) || [], (x) => parseInt(x, 16));
  }

  // Waits up to ms for a drive to be plugged in. Returns null if none was, GONE if the drive
  // in the socket was unplugged (0.3 on), otherwise the bytes it flickered when it introduced
  // itself (empty for an engine that doesn't).
  async wait(ms) {
    const reply = await this.command(`WAIT ${ms}`, ms + 3000);
    if (reply === 'NONE') return null;
    if (reply === 'GONE') return GONE;
    const m = /^DRIVE(?:\s+([0-9A-Fa-f]*))?$/.exec(reply);
    if (!m) throw new StationError(`Unexpected answer from the station: ${reply}`);
    return Uint8Array.from((m[1] || '').match(/../g) || [], (x) => parseInt(x, 16));
  }

  // Is a drive in the socket? (0.3 on; the box checks with one 5 ms dip if it isn't sure.)
  async socket() {
    const reply = await this.command('SOCKET');
    if (reply === 'SOCKET IN') return true;
    if (reply === 'SOCKET EMPTY') return false;
    throw new StationError(`Unexpected answer from the station: ${reply}`);
  }

  // What the box read on the sense wire at the last plug-in (0.3 on), raw ADC counts: empty
  // before, 10 ms in, in the signal's dips, lowest and highest while the drive answered.
  async levels() {
    const reply = await this.command('LEVELS');
    if (reply === 'LEVELS NONE') return null;
    const m = /^LEVELS((?:\s+\d+){5})$/.exec(reply);
    if (!m) throw new StationError(`Unexpected answer from the station: ${reply}`);
    const [empty, inSocket, dip, low, high] = m[1].trim().split(/\s+/).map(Number);
    return { empty, in: inSocket, dip, low, high };
  }

  // Sends every step in order. Stopping happens between steps; the line then rests at full
  // supply, so the drive just carries on with whatever it already had. A step the box answers
  // OK EMPTY (the drive was unplugged) ends the plan: { completed: false, empty: true,
  // failed: that step's index }.
  async run(plan, { onProgress = () => {}, shouldStop = () => false } = {}) {
    const total = planMs(plan);
    let done = 0;
    for (const [i, s] of plan.entries()) {
      if (shouldStop()) return { completed: false, sent: done, total };
      if (!(await this.send(s))) return { completed: false, empty: true, failed: i, sent: done, total };
      done += stepMs(s);
      onProgress({ done, total, step: s });
    }
    return { completed: true, sent: done, total };
  }
}
