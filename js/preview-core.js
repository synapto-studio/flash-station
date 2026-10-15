// Core preview maths: a line-for-line port of the engine in reference/SOTA LED Preview.html
// (itself a port of the Core firmware, integer maths, same results). Used by the Routines tab.
// Do not tidy the maths: test/preview.test.mjs checks it against the reference page.

export const DEFAULTS = {
  BRIGHTNESS: 255,
  WHITE: [255, 235, 200], RED: [255, 0, 0], ORANGE: [255, 45, 0], YELLOW: [255, 140, 0],
  STARTUP_DIM_LEVEL: 40, WHITE_MS: 1000, WHITE_TO_RED_MS: 2500, COLOUR_STEP_MS: 5000,
  BREATHE_MS: 4000, BREATHE_MIN: 70,
  CRANKS: [[0,150,0],[60,260,90],[70,220,140],[40,180,70],[80,150,190],[60,110,160],[60,80,220],[50,60,200],[50,45,240],[45,35,255]],
  CATCH_MS: 350, CATCH_FROM: 110,
};
const fl = Math.floor;
export function ease(x) { return fl((x * x * (765 - 2 * x)) / 65025); }
function progress(pos, len) { return fl(pos * 255 / len); }
function mix(a, b, amount) { const k = amount; return [0,1,2].map(i => fl((a[i] * (255 - k) + b[i] * k) / 255)); }
function ledValue(S, c, level) {
  let k = fl(level * level / 255);
  k = fl(k * S.BRIGHTNESS / 255);
  return [fl(c[0] * k / 255), fl(c[1] * k / 255), fl(c[2] * k / 255)];
}
export function motorStartMs(S) { return S.CRANKS.reduce((a, c) => a + c[0] + c[1], S.CATCH_MS); }
export function outerColour(S, t) {
  const ramp = motorStartMs(S);
  let level = 255;
  if (t < ramp) level = S.STARTUP_DIM_LEVEL + fl((255 - S.STARTUP_DIM_LEVEL) * t / ramp);
  if (t < S.WHITE_MS) return [S.WHITE, level];
  t -= S.WHITE_MS;
  if (t < S.WHITE_TO_RED_MS) return [mix(S.WHITE, S.RED, ease(progress(t, S.WHITE_TO_RED_MS))), level];
  t -= S.WHITE_TO_RED_MS;
  const cycle = [S.RED, S.YELLOW, S.ORANGE, S.RED];
  t %= S.COLOUR_STEP_MS * 3;
  const step = fl(t / S.COLOUR_STEP_MS);
  const amount = ease(progress(t % S.COLOUR_STEP_MS, S.COLOUR_STEP_MS));
  return [mix(cycle[step], cycle[step + 1], amount), level];
}
export function innerLevel(S, t) {
  for (const [on, off, peak] of S.CRANKS) {
    if (t < on) return peak - fl((peak * 2 * t) / (3 * on));
    t -= on;
    if (t < off) return 0;
    t -= off;
  }
  if (t < S.CATCH_MS) return S.CATCH_FROM + fl((255 - S.CATCH_FROM) * ease(progress(t, S.CATCH_MS)) / 255);
  t -= S.CATCH_MS;
  const p = fl((t % S.BREATHE_MS) * 512 / S.BREATHE_MS);
  const wave = p < 256 ? 255 - p : p - 256;
  return S.BREATHE_MIN + fl((255 - S.BREATHE_MIN) * ease(wave) / 255);
}
/* returns the 6 x [r,g,b] bytes the firmware would send at time t (ms since power-on) */
export function render(S, t) {
  const [oc, ol] = outerColour(S, t);
  const o = ledValue(S, oc, ol);
  const i = ledValue(S, S.RED, innerLevel(S, t));
  return [o, o, i, i, o, o];
}
