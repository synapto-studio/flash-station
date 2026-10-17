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
  const seen = new Map();
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] !== 0x5a) continue;
    const id = bytes.slice(i + 1, i + 5);
    if (crc8(id) !== bytes[i + 5]) continue;
    const key = hex(id);
    seen.set(key, (seen.get(key) || 0) + 1);
    i += 5;
  }
  if (!seen.size) return null;
  const [key, copies] = [...seen].sort((a, b) => b[1] - a[1])[0];
  const id = Uint8Array.from(key.match(/../g), (x) => parseInt(x, 16));
  if (id.every((b) => b === 0xff)) return { blank: true, copies };
  const family = String.fromCharCode(id[0]);
  const number = id[1] | (id[2] << 8);
  return {
    blank: false, copies, number,
    family: { C: 'core', P: 'pulse' }[family] || family,
    label: driveLabel(family, number),
    board: BOARDS[id[3]] ? BOARDS[id[3]].code : `board ${id[3]}`,
  };
}

// The bytes a drive with this ID card flickers back (see parseHello): 43 copies after a
// station hello, 3 when it introduces itself on plug-in.
export const HELLO_COPIES = 43;
export const PLUG_COPIES = 3;
export function helloAnswer(card, copies = HELLO_COPIES) {
  const id = card ? card.subarray(5, 9) : Uint8Array.of(0xff, 0xff, 0xff, 0xff);
  const one = [0x5a, ...id, crc8(id)];
  return Uint8Array.from(Array.from({ length: copies }, () => one).flat());
}

// Station firmware that has ASK and WAIT (0.2 on) can read a drive's answer.
export const canListen = (version) => {
  const v = /^(\d+)\.(\d+)/.exec(version || '');
  return !!v && Number(v[1]) * 1000 + Number(v[2]) >= 2;
};

export const stepMs = (s) => Math.round((s.bytes.length * (9 + s.stopBits) * 1000) / s.baud) + s.gapMs;
export const planMs = (plan) => plan.reduce((n, s) => n + stepMs(s), 0);

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`;
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
    const reply = await this.command('HELLO');
    if (!reply.startsWith('SYNAPTO-STATION')) {
      throw new StationError("That port isn't a Synapto station. Pick the XIAO box's port instead.");
    }
    this.version = reply.slice('SYNAPTO-STATION'.length).trim();
    return reply;
  }

  async send(s) {
    const wait = stepMs(s) + 3000;
    const reply = await this.command(`SEND ${s.baud} ${s.stopBits} ${hex(s.bytes)} ${s.gapMs}`, wait);
    if (reply !== 'OK') throw new StationError(`Unexpected answer from the station: ${reply}`);
  }

  // Sends one step like send(), but listens on the sense wire during its gap and returns the
  // bytes the drive flickered back (empty if it said nothing).
  async ask(s) {
    const wait = stepMs(s) + 3000;
    const reply = await this.command(`ASK ${s.baud} ${s.stopBits} ${hex(s.bytes)} ${s.gapMs}`, wait);
    const m = /^HEARD(?:\s+([0-9A-Fa-f]*))?$/.exec(reply);
    if (!m) throw new StationError(`Unexpected answer from the station: ${reply}`);
    return Uint8Array.from((m[1] || '').match(/../g) || [], (x) => parseInt(x, 16));
  }

  // Waits up to ms for a drive to be plugged in. Returns null if none was, otherwise the
  // bytes it flickered when it introduced itself (empty for an engine that doesn't).
  async wait(ms) {
    const reply = await this.command(`WAIT ${ms}`, ms + 3000);
    if (reply === 'NONE') return null;
    const m = /^DRIVE(?:\s+([0-9A-Fa-f]*))?$/.exec(reply);
    if (!m) throw new StationError(`Unexpected answer from the station: ${reply}`);
    return Uint8Array.from((m[1] || '').match(/../g) || [], (x) => parseInt(x, 16));
  }

  // Sends every step in order. Stopping happens between steps; the line then rests at full
  // supply, so the drive just carries on with whatever it already had.
  async run(plan, { onProgress = () => {}, shouldStop = () => false } = {}) {
    const total = planMs(plan);
    let done = 0;
    for (const s of plan) {
      if (shouldStop()) return { completed: false, sent: done, total };
      await this.send(s);
      done += stepMs(s);
      onProgress({ done, total, step: s });
    }
    return { completed: true, sent: done, total };
  }
}
