import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_DEFAULTS, PULSE_DEFAULTS } from '../js/demo.js';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

test('core preview: start-up frames', () => {
  const S = CORE_DEFAULTS;
  // t=0: white glow at the start-up dim level; inner LEDs dark in the first pause
  const f0 = core.render(S, 0);
  assert.equal(f0.length, 6);
  assert.deepEqual(f0[0], f0[5]);
  assert.deepEqual(f0[2], f0[3]);
  assert.deepEqual(f0[2], [0, 0, 0]);
  assert.ok(f0[0][0] > 0 && f0[0][1] > 0 && f0[0][2] > 0, 'outer is white, not dark');
  // motor start ends at 2.16 s with the default cranks (cranks 1805 ms + 350 catch)
  assert.equal(core.crankTotal(S), 1805);
  assert.equal(core.motorStartMs(S), 2155);
  // after the ramp, white glow reaches full: 255,235,200 at full level
  assert.deepEqual(core.render(S, 999)[0].map((v, i) => v > 0 || i === 1), [true, true, true]);
});

test('core preview: steady state is red-orange-yellow loop and a red breath', () => {
  const S = CORE_DEFAULTS;
  const os = S.whiteMs + S.whiteToRedMs;
  assert.deepEqual(core.render(S, os)[0], [255, 0, 0]); // fully red at the end of the fade
  assert.deepEqual(core.render(S, os + S.colourStepMs)[0], [255, 140, 0]); // yellow
  assert.deepEqual(core.render(S, os + S.colourStepMs * 2)[0], [255, 45, 0]); // orange
  assert.deepEqual(core.render(S, os + S.colourStepMs * 3)[0], [255, 0, 0]); // loop
  for (let t = 3000; t < 9000; t += 10) {
    const [r, g, b] = core.render(S, t)[2];
    assert.ok(g === 0 && b === 0, 'inner LEDs are only red');
    assert.ok(r >= Math.floor((S.breatheMin * S.breatheMin) / 255) - 1, 'never goes dark');
  }
});

test('core preview: only the first numCranks cranks count', () => {
  const S = { ...CORE_DEFAULTS, numCranks: 2 };
  assert.equal(core.crankTotal(S), 150 + 60 + 260);
});

test('core preview: phase text and marks', () => {
  assert.equal(core.phaseText(CORE_DEFAULTS, 100).outer, 'White glow, brightening');
  assert.equal(core.phaseText(CORE_DEFAULTS, 100).inner, 'Motor start: stutter');
  assert.equal(core.phaseText(CORE_DEFAULTS, 5000).inner, 'Red pulse');
  assert.deepEqual(core.marks(CORE_DEFAULTS).inner, [1805, 2155]);
});

test('pulse preview: start-up then steady, with the demo track', () => {
  const demo = pulse.synthDnb(44100, {});
  const v = pulse.micVolts(demo.audio, 44100, 'club', 0, 7);
  const st = pulse.stage1(v, 44100, {});
  const res = pulse.stage2(st, PULSE_DEFAULTS);
  assert.ok(st.n > 1000);
  assert.equal(res.leds.length, st.n * 24);
  assert.equal(res.phaseEnds.length, 7);
  const steadyAt = (res.phaseEnds[6] + res.startMs) / 1000;
  assert.ok(steadyAt > 8 && steadyAt < 10, `start-up ends ~${steadyAt}`);
  // the drum track is heard and the grid locks near 174 BPM
  const last = st.n - 1;
  assert.ok(res.kOn.some((x) => x) && res.sOn.some((x) => x), 'kicks and snares detected');
  let locked = -1;
  for (let i = 0; i < st.n; i++) if (res.conf[i] >= 4) { locked = i; break; }
  assert.ok(locked > 0, 'locks on to the beat');
  assert.ok(Math.abs(res.bpm[last] - 174) < 3, `bpm ${res.bpm[last]}`);
  // changing a setting re-runs stage 2 only, and changes the picture
  const dim = pulse.stage2(st, { ...PULSE_DEFAULTS, brightness: 100 });
  assert.notDeepEqual(dim.leds, res.leds);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(dim.leds) < sum(res.leds));
});

test('pulse preview: no music gives the steady look with no hits', () => {
  const v = pulse.micVolts(new Float32Array(44100 * 12), 44100, 'silence', 0, 7);
  const res = pulse.stage2(pulse.stage1(v, 44100, {}), PULSE_DEFAULTS);
  assert.ok(!res.kOn.some((x) => x));
});
