// The preview maths must give the same numbers as the reference pages it was ported from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';

const plain = (v) => JSON.parse(JSON.stringify(v)); // arrays made inside vm have another prototype
const page = (name) => readFileSync(new URL(`../reference/${name}`, import.meta.url), 'utf8');

function refCore() {
  const h = page('SOTA LED Preview.html');
  const src = h.slice(h.indexOf('/* ===== ENGINE'), h.indexOf('/* ===== END ENGINE'));
  return vm.runInNewContext(`${src}\n({ DEFAULTS, render, motorStartMs })`);
}

function refPulse() {
  const h = page('SOTA Pulse Preview.html');
  const a = h.indexOf('var PulseEngine');
  const b = h.indexOf('/* ===== END PULSE ENGINE');
  return vm.runInNewContext(`${h.slice(a, b)}\nPulseEngine`);
}

test('Core: every 10 ms for 25 s matches the reference page', () => {
  const ref = refCore();
  assert.deepEqual(JSON.parse(JSON.stringify(ref.DEFAULTS)), core.DEFAULTS);
  for (let t = 0; t < 25000; t += 10) {
    assert.deepEqual(core.render(core.DEFAULTS, t), plain(ref.render(ref.DEFAULTS, t)), `t=${t}`);
  }
  assert.equal(core.motorStartMs(core.DEFAULTS), ref.motorStartMs(ref.DEFAULTS));
});

test('Core: a changed setting changes the lights the same way', () => {
  const ref = refCore();
  const S = structuredClone(core.DEFAULTS); S.BRIGHTNESS = 120; S.WHITE_MS = 1500; S.BREATHE_MIN = 20;
  const R = JSON.parse(JSON.stringify(S));
  for (let t = 0; t < 12000; t += 10) assert.deepEqual(core.render(S, t), plain(ref.render(R, t)), `t=${t}`);
});

test('Pulse: demo track in a club matches the reference page, LED byte for LED byte', () => {
  const ref = refPulse();
  const run = (E) => {
    const d = E.synthDnb(8000, { bars: 6 });
    const v = E.micVolts(d.audio, 8000, 'club', 1, 7);
    return E.stage2(E.stage1(v, 8000), E.DEFAULTS);
  };
  const a = run(pulse), b = run(ref);
  assert.ok(a.leds.length > 24 * 100, 'ran for a while');
  assert.deepEqual(Buffer.from(a.leds), Buffer.from(b.leds));
  assert.deepEqual(Buffer.from(a.kOn), Buffer.from(b.kOn));
  assert.ok(a.kOn.some(Boolean), 'found kicks');
});

test('Pulse: changed settings match too', () => {
  const ref = refPulse();
  const d = pulse.synthDnb(8000, { bars: 4 });
  const v = pulse.micVolts(d.audio, 8000, 'home', 1, 7);
  const st = pulse.stage1(v, 8000);
  const S = { ...pulse.DEFAULTS, brightness: 150, topPulses: 2, bottomLevel: 120, kickMin: 60 };
  const a = pulse.stage2(st, S);
  const b = ref.stage2(st, JSON.parse(JSON.stringify({ ...S })));
  assert.deepEqual(Buffer.from(a.leds), Buffer.from(b.leds));
});
