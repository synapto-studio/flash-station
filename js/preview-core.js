// Live preview of the coretest engine (Core, ATtiny412): what the 6 LEDs do from the moment
// USB power arrives. Ported from reference/SOTA LED Preview.html, itself a line-for-line port
// of the firmware's integer maths. Settings use the names of the SOTA.LED layout in engines.js
// (so `unpackSettings('SOTA.LED', ...)` output can be passed straight in).

const fl = Math.floor;
const ease = (x) => fl((x * x * (765 - 2 * x)) / 65025);
const progress = (pos, len) => fl((pos * 255) / len);
const mix = (a, b, k) => [0, 1, 2].map((i) => fl((a[i] * (255 - k) + b[i] * k) / 255));

export const TIMELINE_MS = 20000;
export const TICK_MS = 10; // the firmware updates every 10 ms

const cranksOf = (S) => (S.numCranks == null ? S.cranks : S.cranks.slice(0, S.numCranks));

function ledValue(S, c, level) {
  let k = fl((level * level) / 255);
  k = fl((k * S.brightness) / 255);
  return [fl((c[0] * k) / 255), fl((c[1] * k) / 255), fl((c[2] * k) / 255)];
}

// How long the inner LEDs stutter, then catch: also the outer LEDs' brighten-up time.
export const crankTotal = (S) => cranksOf(S).reduce((a, c) => a + c[0] + c[1], 0);
export const motorStartMs = (S) => crankTotal(S) + S.catchMs;

function outerColour(S, t) {
  const ramp = motorStartMs(S);
  let level = 255;
  if (t < ramp) level = S.startupDim + fl(((255 - S.startupDim) * t) / ramp);
  if (t < S.whiteMs) return [S.white, level];
  t -= S.whiteMs;
  if (t < S.whiteToRedMs) return [mix(S.white, S.red, ease(progress(t, S.whiteToRedMs))), level];
  t -= S.whiteToRedMs;
  const cycle = [S.red, S.yellow, S.orange, S.red];
  t %= S.colourStepMs * 3;
  const step = fl(t / S.colourStepMs);
  return [mix(cycle[step], cycle[step + 1], ease(progress(t % S.colourStepMs, S.colourStepMs))), level];
}

function innerLevel(S, t) {
  for (const [on, off, peak] of cranksOf(S)) {
    if (t < on) return peak - fl((peak * 2 * t) / (3 * on));
    t -= on;
    if (t < off) return 0;
    t -= off;
  }
  if (t < S.catchMs) return S.catchFrom + fl(((255 - S.catchFrom) * ease(progress(t, S.catchMs))) / 255);
  t -= S.catchMs;
  const p = fl(((t % S.breatheMs) * 512) / S.breatheMs);
  const wave = p < 256 ? 255 - p : p - 256;
  return S.breatheMin + fl(((255 - S.breatheMin) * ease(wave)) / 255);
}

// The 6 x [r,g,b] bytes the firmware sends at time t (ms since power-on), LED 1 first.
export function render(S, t) {
  const [oc, ol] = outerColour(S, t);
  const o = ledValue(S, oc, ol);
  const i = ledValue(S, S.red, innerLevel(S, t));
  return [o, o, i, i, o, o];
}

// Plain words for what each group is doing at time t.
export function phaseText(S, t) {
  const os = S.whiteMs + S.whiteToRedMs;
  let outer;
  if (t < S.whiteMs) outer = 'White glow';
  else if (t < os) outer = 'Fading to red';
  else outer = ['Red → yellow', 'Yellow → orange', 'Orange → red'][fl(((t - os) % (S.colourStepMs * 3)) / S.colourStepMs)];
  if (t < motorStartMs(S)) outer += ', brightening';
  const ct = crankTotal(S);
  const inner = t < ct ? 'Motor start: stutter' : t < ct + S.catchMs ? 'Motor start: catching' : 'Red pulse';
  return { outer, inner };
}

// Times (ms) where something changes, for marking the timeline.
export function marks(S) {
  const os = S.whiteMs + S.whiteToRedMs;
  const outer = [S.whiteMs, motorStartMs(S), os];
  for (let k = 1; os + k * S.colourStepMs < TIMELINE_MS; k++) outer.push(os + k * S.colourStepMs);
  return { outer, inner: [crankTotal(S), motorStartMs(S)] };
}
