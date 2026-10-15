// The Initialisation Station: check what's on the pins, then put an engine, its settings,
// the right BOOTEND fuse and an ID card on it, verifying each part.

import { UpdiProgrammer } from './updi.js';
import { readEngine, PULSE, layoutSize } from './engines.js';
import { decodeCard } from './idcard.js';
import { FUSE } from './devices.js';

export const FAMILIES = {
  core: {
    name: 'Core',
    chipName: 'ATtiny412',
    switchV: '5V',
    letter: 'C',
    leds: 6,
    boards: ['Core A'],
    checks: ['The 470 Ω on the UPDI line is bridged, or the pogo pin is on the chip side of it.'],
    engineKinds: ['coretest'],
  },
  pulse: {
    name: 'Pulse',
    chipName: 'ATtiny1614',
    switchV: '3V',
    letter: 'P',
    leds: 8,
    boards: ['Pulse A2', 'Pulse A1'],
    checks: ['6R1 is bridged.', 'The 15k / 10k divider is fitted (pin 4 reads about 2.0 V on USB power). Needed for the Flash Station, not for initialising.'],
    engineKinds: ['pulsetest', 'beat'],
  },
};

const FAMILY_OF_CHIP = { core: 'core', pulse: 'pulse', pulseB: 'pulseB' };

// Plain-English messages for everything that can go wrong at the pins.
export function explain(e, family) {
  const f = FAMILIES[family];
  switch (e && e.code) {
    case 'no-echo':
      return "The UPDI Friend isn't answering. Check its USB cable, and that you picked its port when connecting.";
    case 'no-chip':
      return `No chip answered. Check the pogo pin sits on the UPDI pad, the board has power from its USB plug, and the UPDI Friend switch is on ${f ? f.switchV : 'the right voltage'}.${family === 'pulse' ? ' On Pulse, 6R1 must be bridged.' : family === 'core' ? ' On Core, the 470 Ω on the UPDI line must be bridged, or put the pogo pin on the chip side of it.' : ''}`;
    case 'locked':
      return 'The chip is locked. That should never happen with these engines: ask before going further.';
    case 'wrong-board':
    case 'other-board':
    case 'unsupported-board':
    case 'verify':
    case 'demo-engine':
      return e.message;
    default:
      return (e && e.message) || String(e);
  }
}

class StationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkFamily(info, family) {
  if (!info.device) throw new StationError('wrong-board', `Unknown chip on the pins (ID ${info.idHex}).`);
  const got = FAMILY_OF_CHIP[info.device.family];
  if (got === 'pulseB') {
    throw new StationError('unsupported-board', 'That\'s an ATtiny3216 (Pulse B). Pulse B needs its own pulsetest build first.');
  }
  if (got !== family) {
    const other = FAMILIES[got];
    throw new StationError('wrong-board',
      `That's a ${other.name} board (${other.chipName}), but ${FAMILIES[family].name} is selected. Pick ${other.name}, set the UPDI Friend switch to ${other.switchV}, then check again.`);
  }
}

// What's on a chip's flash, in words. Compares against the library's engines when it can.
export function describeFlash(flash, engines = []) {
  if (flash.every((b) => b === 0xff)) return { blank: true, label: 'Blank' };
  const mem = new Map();
  let end = flash.length;
  while (end > 0 && flash[end - 1] === 0xff) end--;
  for (let i = 0; i < end; i++) mem.set(i, flash[i]);
  const engine = readEngine(mem, '');
  if (engine.kind === 'unknown') return { blank: false, label: 'Unknown firmware', engine };
  let match = null;
  for (const e of engines) {
    if (e.kind !== engine.kind) continue;
    if (sameCode(e, engine)) {
      match = e;
      break;
    }
  }
  return {
    blank: false,
    engine,
    match,
    label: match ? match.label : engine.kind === 'pulsetest' ? engine.label : engine.kind,
    settings: engine.defaults,
  };
}

// Same engine code, whatever the settings: compare everything except the settings block.
function sameCode(a, b) {
  if (a.kind === 'pulsetest') {
    if (a.app.length !== b.app.length) return false;
    const sp = settingsPage(a);
    for (let i = 0; i < a.app.length; i++) {
      if (((i / PULSE.PAGE) | 0) === sp) continue;
      if (a.app[i] !== b.app[i]) return false;
    }
    return a.boot.every((x, i) => x === b.boot[i]);
  }
  if (a.settingsOffset !== b.settingsOffset) return false;
  const lo = a.settingsOffset, hi = lo + layoutSize(a.tag);
  const n = Math.max(a.flash.length, b.flash.length);
  for (let i = 0; i < n; i++) {
    if (i >= lo && i < hi) continue;
    if ((a.flash[i] ?? 0xff) !== (b.flash[i] ?? 0xff)) return false;
  }
  return true;
}
function settingsPage(e) {
  for (let i = 0; i < e.app.length; i += PULSE.PAGE) {
    if (String.fromCharCode(...e.app.subarray(i, i + 8)) === 'SOTA.PLS') return i / PULSE.PAGE;
  }
  return -1;
}

export async function checkBoard(transport, family, { baud, log, engines = [], onProgress = () => {} } = {}) {
  const p = new UpdiProgrammer(transport, { baud, log });
  try {
    await p.connect();
    const info = await p.identify();
    checkFamily(info, family);
    const flash = await p.readFlash(0, info.device.flashSize, (d, n) => onProgress(d / n));
    const onChip = describeFlash(flash, engines);
    const card = decodeCard(info.userRow);
    const warnings = [];
    if ((info.fuses[FUSE.OSCCFG] & 0x03) !== 0x02) {
      warnings.push(`The oscillator fuse is 0x${info.fuses[FUSE.OSCCFG].toString(16)}, not the factory 20 MHz. The engines expect 20 MHz.`);
    }
    return { info, onChip, card, warnings };
  } finally {
    await p.disconnect();
  }
}

// steps reported through onStep(name, fraction): erase, write, verify, fuse, card, done
export async function initialiseBoard(transport, { family, image, card, expectSerial = null, baud, log, onStep = () => {}, engine }) {
  if (engine && engine.demo && !transport.simulated) {
    throw new StationError('demo-engine', 'Demo engines are only for the simulated board. Pick a real engine from your library.');
  }
  const p = new UpdiProgrammer(transport, { baud, log });
  try {
    await p.connect();
    const info = await p.identify();
    checkFamily(info, family);
    if (expectSerial && info.serial !== expectSerial) {
      throw new StationError('other-board', 'A different board is on the pins from the one you checked. Check it again first.');
    }
    if (image.flash.length > info.device.flashSize) throw new StationError('verify', 'That engine is too big for this chip.');

    onStep('erase', 0);
    await p.chipErase();
    onStep('write', 0);
    await p.writeFlash(0, image.flash, (i, n) => onStep('write', i / n));
    onStep('verify', 0);
    const back = await p.readFlash(0, info.device.flashSize, (d, n) => onStep('verify', d / n));
    for (let i = 0; i < back.length; i++) {
      const want = i < image.flash.length ? image.flash[i] : 0xff;
      if (back[i] !== want) throw new StationError('verify', `Verify failed at flash address 0x${i.toString(16)}. Nothing is wrong with the file; try again, and if it repeats, lower the speed.`);
    }

    onStep('fuse', 0);
    const fuses = await p.readFuses();
    if (fuses[FUSE.APPEND] !== 0x00) await p.writeFuse(FUSE.APPEND, 0x00);
    if (fuses[FUSE.BOOTEND] !== image.bootend) await p.writeFuse(FUSE.BOOTEND, image.bootend);
    const after = await p.readFuses();
    if (after[FUSE.BOOTEND] !== image.bootend || after[FUSE.APPEND] !== 0) {
      throw new StationError('verify', 'The BOOTEND fuse did not take. Try again.');
    }

    onStep('card', 0);
    await p.writeUserRow(card);
    const row = await p.readUserRow();
    if (row.some((b, i) => b !== card[i])) throw new StationError('verify', "The ID card didn't verify. Try again.");
    onStep('done', 1);
    return { info };
  } finally {
    await p.disconnect();
  }
}

export function driveRecord({ existing, label, family, number, board, casing, info, engine, routineName, image, settings }) {
  const now = new Date().toISOString();
  const event = {
    date: now,
    station: 'Initialisation Station',
    action: existing ? 'Re-initialised' : 'Initialised',
    engine: engine.label,
    engineFile: engine.fileName,
    routine: routineName || 'Engine defaults',
    imageId: image.imageId.toString(16).toUpperCase().padStart(4, '0'),
  };
  return {
    drive: label,
    family,
    number,
    board,
    casing,
    chip: info.device.name,
    chipRevision: info.revision,
    chipSerial: info.serial,
    engine: { label: engine.label, file: engine.fileName, kind: engine.kind },
    routine: routineName || null,
    settings,
    initialised: existing ? existing.initialised : now,
    updated: now,
    history: [...((existing && existing.history) || []), event],
  };
}
