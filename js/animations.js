// Today's looks rebuilt as player recipes (roadmap R2): Core's Engine (start-up) and Drift
// (ambient), Pulse's start-up and ambient, and the plug-in Heartbeat. Each is built from the
// engine's settings, so the Routines tab's "Tune it" fields change both. docs/ANIMATION-FORMAT.md
// explains the moves; test/player.test.mjs checks them against today's preview maths.

import * as core from './preview-core.js';
import * as pulse from './preview-pulse.js';


const OUTER = [1, 2, 5, 6], INNER = [3, 4];               // Core
const BOTTOM = [1, 2, 7, 8], MIDDLE = [3, 4], TOP = [5, 6]; // Pulse
const RED = 1, ORANGE = 2, WHITE = 3, YELLOW = 4, STATION = 5;
const r10 = (ms) => Math.round(ms / 10) * 10;

// Core, start-up: white glow, white to red on the outer LEDs (brightening from dim while the motor
// starts), the inner LEDs crank like a motor, catch, rev up and start to breathe.
export function coreEngine(S = core.DEFAULTS) {
  const ramp = core.motorStartMs(S);
  let wait = 0, cranks = S.CRANKS.map((c) => [...c]);
  while (cranks.length > 1 && cranks[0][0] === 0 && cranks[0][2] === 0) { wait += cranks[0][1]; cranks.shift(); } // a dark first crank is a wait
  const crankEnd = wait + cranks.reduce((n, c) => n + c[0] + c[1], 0);
  return {
    type: 'animation', name: 'Engine', board: 'core', timing: 'ms', once: true,
    layers: [
      { move: 'glow', leds: OUTER, for: S.WHITE_MS, colour: WHITE, level: 255 },
      { move: 'fade', leds: OUTER, at: S.WHITE_MS, for: S.WHITE_TO_RED_MS, colour: [WHITE, RED], level: [255, 255], curve: 'ease' },
      { move: 'fade', leds: OUTER, for: r10(ramp), level: [S.STARTUP_DIM_LEVEL, 255], curve: 'linear', blend: 'mask' },
      { move: 'hits', leds: INNER, at: wait, colour: RED, fadeTo: 85, hits: cranks },
      { move: 'fade', leds: INNER, at: crankEnd, for: S.CATCH_MS, colour: [RED, RED], level: [S.CATCH_FROM, 255], curve: 'ease' },
      { move: 'breathe', leds: INNER, at: crankEnd + S.CATCH_MS, colour: RED, low: S.BREATHE_MIN, high: 255, every: S.BREATHE_MS },
    ],
  };
}
const engineLength = (S) => Math.max(S.WHITE_MS + S.WHITE_TO_RED_MS, core.motorStartMs(S));

// Core, ambient: the outer LEDs drift red, yellow, orange; the inner ones breathe red. The phases
// pick up exactly where Engine leaves them.
export function coreDrift(S = core.DEFAULTS) {
  const after = engineLength(S);
  return {
    type: 'animation', name: 'Drift', board: 'core', timing: 'ms', once: false,
    layers: [
      { move: 'drift', leds: OUTER, colours: [RED, YELLOW, ORANGE], level: 255, every: S.COLOUR_STEP_MS, phase: r10(after - S.WHITE_MS - S.WHITE_TO_RED_MS) },
      { move: 'breathe', leds: INNER, colour: RED, low: S.BREATHE_MIN, high: 255, every: S.BREATHE_MS, phase: r10((after - core.motorStartMs(S)) % S.BREATHE_MS) },
    ],
  };
}

// Pulse, start-up, as a step list: a white glow rises, the top pulses, goes multicoloured, the
// colours pour down, everything fades to white, drains into the plug, and red flows back up
// leaving the ambient look behind it.
export function pulseStartup(S = pulse.DEFAULTS) {
  const per = S.topPulseMs / (S.topPulses || 1);
  return {
    type: 'animation', name: 'Pulse start-up', board: 'pulse', timing: 'ms', once: true,
    steps: [
      { for: S.riseMs, layers: [{ move: 'wave', leds: 'all', colour: WHITE, low: 0, high: S.glowLevel, from: -30, to: 100, width: 45, curve: 'ease', land: true }] },
      { for: S.topPulseMs, layers: [{ move: 'pulse', leds: TOP, colour: WHITE, low: S.glowLevel, high: 255, every: r10(per), rise: r10(per * 64 / 255), fall: r10(per * 191 / 255), up: 'ease', down: 'ease' }] },
      { for: S.multiMs, layers: [
        { move: 'rainbow', leds: 'all', for: S.multiMs + S.pourMs + S.whiteMs, level: 220, every: 700, lag: -240, twist: 40 },
        { move: 'glow', leds: [...BOTTOM, ...MIDDLE], colour: 0, level: 0 },
        { move: 'fade', leds: TOP, for: 150, colour: [WHITE, WHITE], level: [255, 0], curve: 'linear', blend: 'tint' },
      ] },
      { for: S.pourMs, layers: [{ move: 'fill', leds: [...BOTTOM, ...MIDDLE], level: 255, from: 100, to: -30, edge: 30, curve: 'ease', side: 'above', blend: 'mask' }] },
      { for: S.whiteMs, layers: [{ move: 'fade', leds: 'all', colour: [WHITE, WHITE], level: [0, 255], curve: 'ease', blend: 'tint' }] },
      { for: S.drainMs, layers: [
        { move: 'glow', leds: 'all', colour: WHITE, level: 220 },
        { move: 'fill', leds: 'all', level: 255, from: 130, to: -30, edge: 30, curve: 'in', side: 'below', blend: 'mask' },
      ] },
      { for: S.flowMs, layers: [{ move: 'wipe', leds: 'all', colour: RED, level: 255, from: -30, to: 144, crest: 15, behind: 40, curve: 'out' }] },
    ],
  };
}

// Pulse, ambient (today's steady look), in beats: the bottom drifts red to orange and back over
// `cycleBars` bars, the middle glows dim red, the top pulses on every bar's downbeat, and kicks
// lift each section once the music is loud enough there.
export function pulseAmbient(S = pulse.DEFAULTS) {
  return {
    type: 'animation', name: 'Pulse ambient', board: 'pulse', timing: 'beats', once: false,
    layers: [
      { move: 'drift', leds: BOTTOM, colours: [RED, ORANGE], level: S.bottomLevel, every: (S.cycleBars || 1) * 2 },
      { move: 'glow', leds: MIDDLE, colour: RED, level: S.middleLevel },
      { move: 'pulse', leds: TOP, colour: RED, low: S.topLow, high: S.topHigh, every: 4, rise: 0.25, fall: 3.75, up: 'linear', down: 'out' },
      { move: 'kick', leds: BOTTOM, loud: S.loudBottom },
      { move: 'kick', leds: MIDDLE, loud: S.loudMiddle },
      { move: 'kick', leds: TOP, loud: S.loudTop },
    ],
  };
}

// The plug-in heartbeat (station mode, after the white handshake pulse): 12 heartbeats out from
// the socket, then one flow up the box and drive and back, on a 38.6 s loop, in the box's warm
// white. Levels are the plug-in preview's (60 resting, 97 beat, 120 flow) turned into the
// player's levels, which are squared on the way out: 60 -> 124, 97 -> 157, 60 + 120 -> 214.
export function heartbeat() {
  return {
    type: 'animation', name: 'Heartbeat', board: 'any', timing: 'ms', once: false,
    layers: [
      { move: 'glow', leds: 'all', colour: STATION, level: 124 },
      { move: 'pulse', leds: 'all', at: 0, for: 36000, colour: STATION, low: 124, high: 157, every: 3000, rise: 90, fall: 1880, up: 'ease', down: 'exp', lag: 130 },
      { move: 'wave', leds: 'all', at: 36000, for: 2600, colour: STATION, low: 124, high: 214, from: -200, to: 100, width: 135, curve: 'ease', round: true, back: true },
    ],
  };
}

// The plug-in pulse (station mode, from the moment the drive goes in until the heartbeats start
// at 2146 ms): the drive glows at the bootloader's listening level while the box's half of the
// white pulse spreads out from the socket (the ID flickers inside it at 886 ms: that's engine
// code, not the recipe), then fades out from the plug up, then the resting glow. Levels as in
// heartbeat(): the box's 86 -> 148, 60 -> 124. The fade is a fill draining upwards: today each
// section fades over 310 ms, 120 ms after the one below (firmware pulsetest 1.10 showLevels).
export function pluginPulse() {
  return {
    type: 'animation', name: 'Plug-in', board: 'any', timing: 'ms', once: true,
    layers: [
      { move: 'glow', leds: 'all', for: 1230, colour: STATION, level: 148 },
      { move: 'fill', leds: 'all', at: 1230, for: 550, colour: STATION, level: 148, from: -64, to: 164, edge: 129, curve: 'linear', side: 'above' },
      { move: 'glow', leds: 'all', at: 1900, for: 250, colour: STATION, level: 124 },
    ],
  };
}

// An example for the Animation lab (R3), from the roadmap's description: "on the drop: white
// fill from the plug up, then red strobes on every beat for 2 bars". A one-shot in beats.
export function dropExample() {
  return {
    type: 'animation', name: 'Drop (example)', board: 'pulse', timing: 'beats', once: true,
    notes: 'On the drop: white fills from the plug up over one bar, then red strobes on every beat for 2 bars.',
    steps: [
      { for: 4, layers: [{ move: 'fill', leds: 'all', colour: WHITE, level: 255, from: -20, to: 120, edge: 30, curve: 'in' }] },
      { for: 8, layers: [{ move: 'pulse', leds: 'all', colour: RED, low: 0, high: 255, every: 1, rise: 0, fall: 0.5, down: 'out' }] },
    ],
  };
}

// ---------------------------------------------------------------- today's heartbeat, for comparing
// The plug-in preview's drive half (firmware repo station/preview/plugin_animation.html, Jonny's
// look of 18 Oct 2026; the numbers are in docs/STATION-PROTOCOL.md). ct: ms into the heartbeat
// loop; plugMs: ms after plug-in (for the sparkle). heights: each LED's 0-10000 from the plug.
// Returns each LED's [r, g, b] as the drive shows it (station white, levels not squared).
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
function hash(a, b) {
  let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h & 0xFF;
}
export function heartbeatToday(ct, heights, plugMs = ct + 2146) {
  const NB = 4, CYCLE = 12 * 3000 + 2 * 1300;
  ct %= CYCLE;
  const distinct = [...new Set(heights)].sort((a, b) => a - b);
  return heights.map((h) => {
    const pos = NB + 2 * h / 10000;
    let L;
    if (ct < 36000) {
      const x = (ct % 3000) - (pos - NB) * 65;
      const env = x < 0 ? 0 : x < 90 ? smooth(x / 90) : Math.exp(-(x - 90) / (720 / 2.2));
      L = 60 + (97 - 60) * Math.min(1, env);
    } else {
      const ft = ct - 36000, u = ft / 1300, c = (u < 1 ? smooth(u) : smooth(2 - u)) * (NB + 2);
      const d = (pos - c) / 2.7, band = Math.abs(d) >= 1 ? 0 : (1 - d * d) ** 2;
      const id = NB + distinct.indexOf(h), step = Math.floor(plugMs / 60), f = smooth((plugMs % 60) / 60);
      const a = hash(id, step), b = hash(id, step + 1), sparkle = ((a + (b - a) * f) - 128) / 128 * 8;
      L = 60 + (120 * band + sparkle * band) * Math.min(smooth(ft / 250), smooth((2600 - ft) / 250));
    }
    const l = Math.max(0, Math.min(255, Math.round(L)));
    return [l, l - (l >> 5), l - Math.floor(l / 12)];
  });
}

// Today's Pulse look and what the player needs from the same run: per 12.8 ms block, the music
// clock (bar phase shown early by leadMs, smooth beats), the kick surge and the loudness.
export function pulseMusic(run, st) {
  const n = st.n, beats = new Float64Array(n);
  for (let i = 1; i < n; i++) beats[i] = beats[i - 1] + Math.floor((st.now[i] - st.now[i - 1]) * 1048576 / run.period[i]);
  const at = (ms) => { // the last block at or before ms
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st.now[mid] <= ms) lo = mid; else hi = mid - 1; }
    return lo;
  };
  return (ms) => { const i = at(ms + run.startMs); return { bar: run.barLead[i], beats: beats[i], kick: run.kick[i], loud: run.loud[i] }; };
}
