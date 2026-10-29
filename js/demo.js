// Demo engines for the simulated board: the real settings blocks with the real defaults,
// wrapped in made-up code. They let the whole Initialise flow be tried with no hardware.
// The app refuses to put them on a real chip.

import { packSettings, readEngine, PulseImage, PULSE } from './engines.js';
import { packShow, defaultShow } from './show.js';
import { packPrint } from './songs.js';
import { dropExample } from './animations.js';

export const PULSE_DEFAULTS = {
  tag: 'SOTA.PLS', layout: 1, brightness: 255,
  white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0],
  riseMs: 1200, topPulseMs: 1000, multiMs: 2000, pourMs: 1000, whiteMs: 2000, drainMs: 800, flowMs: 1000,
  topPulses: 3, glowLevel: 150, bottomLevel: 170, middleLevel: 80, topHigh: 215, topLow: 180, cycleBars: 4,
  bpmX10: 1740, bpmMin: 165, bpmMax: 180, leadMs: 20, micTrimDb: 0, loudTop: 85, loudMiddle: 95, loudBottom: 100,
  kickFadeMs: 160, kickMin: 90, kickJumpX10: 14, kickLoudX10: 15, kickMinPct: 45, kickFloorUv: 200, kickGapMs: 150,
  snareJumpX10: 16, snareLoudX10: 35, snareMinPct: 50, snareFloorUv: 20,
};

export const CORE_DEFAULTS = {
  tag: 'SOTA.LED', layout: 1, brightness: 255,
  white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0], yellow: [255, 140, 0],
  startupDim: 40, whiteMs: 1000, whiteToRedMs: 2500, colourStepMs: 5000, catchMs: 350, catchFrom: 110,
  breatheMs: 4000, breatheMin: 70, numCranks: 10,
  cranks: [[0, 150, 0], [60, 260, 90], [70, 220, 140], [40, 180, 70], [80, 150, 190], [60, 110, 160],
    [60, 80, 220], [50, 60, 200], [50, 45, 240], [45, 35, 255], [0, 0, 0], [0, 0, 0]],
};

// Pulse engine 2 (settings layout 2): the looks are in its show, so the page keeps less.
const PULSE2_DEFAULTS = {
  tag: 'SOTA.PLS', layout: 2, brightness: 255, white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0],
  bpmX10: 1740, bpmMin: 165, bpmMax: 180, leadMs: 20, micTrimDb: 0, kickFadeMs: 160, kickMin: 90,
  kickJumpX10: 14, kickLoudX10: 15, kickMinPct: 45, kickFloorUv: 200, kickGapMs: 150,
  snareJumpX10: 16, snareLoudX10: 35, snareMinPct: 50, snareFloorUv: 20, showPage: 0, showLen: 0, showCrc: 0xffff,
};

// A made-up song moment for the demo engine 2 (its print isn't from a real song), and the demo
// library's file for it, so the Flash Station tab can name it. It plays the lab's drop example.
const demoPrint = () => {
  const n = 24, f = filler(2 * n, 14);
  const hex = Array.from(packPrint({ frames: n, maxErr: 30, partMax: [16, 16, 16, 16], value: f.subarray(0, n), mask: f.subarray(n) }), (x) => x.toString(16).padStart(2, '0')).join('');
  return hex;
};
export function demoMoment() {
  return {
    type: 'song-moment', name: 'Demo drop', board: 'pulse', song: 'Demo track', bpm: 174, firstBar: 0,
    listenFrom: 30, listenTo: 35.517, playAt: 35.517, delayMs: 0, delayBeats: 0,
    animation: 'Drop (example)', repeat: 'every', print: demoPrint(), kept: 0, heard: null, recognisedAt: null, alsoHeardAt: [], checkedAgainst: [],
  };
}

function filler(n, seed) {
  let s = seed;
  return Uint8Array.from({ length: n }, () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff);
}

export function demoEngines() {
  const core = new Map();
  const cf = filler(3448, 11);
  cf.set(packSettings('SOTA.LED', CORE_DEFAULTS), 2048);
  cf.forEach((b, i) => core.set(i, b));

  const pulse = new Map();
  filler(2988, 12).forEach((b, i) => pulse.set(i, b));
  const app = filler(12372, 13);
  app.set(packSettings('SOTA.PLS', PULSE_DEFAULTS), 3 * 64);
  app.forEach((b, i) => pulse.set(0x0c00 + i, b));

  // engine 2: today's looks and the demo song moment in its show, after the routine
  const pulse2 = new Map(pulse);
  for (const a of [...pulse2.keys()]) if (a >= 0x0c00) pulse2.delete(a);
  const app2 = filler(12992, 15);
  app2.set(packSettings('SOTA.PLS', PULSE2_DEFAULTS), 190 * 64);
  const show = packShow({ ...defaultShow(), moments: [{ print: demoPrint(), animation: dropExample(), delayMs: 0, repeat: 'every' }] });
  const img = new PulseImage(app2, [2, 5], null, show);
  for (const [p, d] of img.pages()) d.forEach((b, i) => pulse2.set(PULSE.APP_START + p * PULSE.PAGE + i, b));

  return [
    readEngine(core, 'demo_coretest_1.3_10mhz.hex'),
    readEngine(pulse, 'demo_pulsetest_1.0_full.hex'),
    readEngine(pulse2, 'demo_pulsetest_2.5_full.hex'),
  ].map((e) => ({ ...e, demo: true, label: `${e.label} (demo)` }));
}
