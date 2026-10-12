// Demo engines for the simulated board: the real settings blocks with the real defaults,
// wrapped in made-up code. They let the whole Initialise flow be tried with no hardware.
// The app refuses to put them on a real chip.

import { packSettings, readEngine } from './engines.js';

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

  return [
    readEngine(core, 'demo_coretest_1.2_10mhz.hex'),
    readEngine(pulse, 'demo_pulsetest_1.0_full.hex'),
  ].map((e) => ({ ...e, demo: true, label: `${e.label} (demo)` }));
}
