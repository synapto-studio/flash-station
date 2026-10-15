// The Preview tab: live previews of what a Core or a Pulse drive's lights will do, using the
// same maths as the firmware (js/preview-core.js, js/preview-pulse.js). No audio, no hardware.
// Pulse plays a built-in drum and bass demo through the simulated mic.

import * as core from './preview-core.js';
import * as pulse from './preview-pulse.js';

const CORE_FIELDS = [
  ['BRIGHTNESS', 'Overall brightness (0–255)', 1, 255],
  ['STARTUP_DIM_LEVEL', 'Start-up brightness (0–255)', 0, 255],
  ['WHITE_MS', 'White glow (ms)', 0, 3000],
  ['WHITE_TO_RED_MS', 'White to red fade (ms)', 100, 4000],
  ['COLOUR_STEP_MS', 'Each colour fade (ms, ×3 = loop)', 200, 20000],
  ['BREATHE_MS', 'Red pulse length (ms)', 400, 20000],
  ['BREATHE_MIN', 'Red pulse dimmest (0–255)', 0, 250],
];
const PULSE_FIELDS = [
  ['brightness', 'Overall brightness (0–255)', 1, 255],
  ['riseMs', 'Rise (ms)', 200, 4000],
  ['glowLevel', 'Glow level (0–255)', 0, 255],
  ['topPulses', 'Top pulses', 1, 8],
  ['bottomLevel', 'Bottom level (0–255)', 0, 255],
  ['middleLevel', 'Middle level (0–255)', 0, 255],
  ['topHigh', 'Top, high (0–255)', 0, 255],
  ['topLow', 'Top, low (0–255)', 0, 255],
  ['kickMin', 'Kick flash, lowest (0–255)', 0, 255],
  ['cycleBars', 'Bottom colour cycle (bars)', 1, 16],
];
const CORE_COLOURS = [['WHITE', 'White glow'], ['RED', 'Red'], ['YELLOW', 'Yellow'], ['ORANGE', 'Orange']];
const PULSE_COLOURS = [['white', 'White'], ['red', 'Red'], ['orange', 'Orange']];
const CORE_LEDS = ['LED 1', 'LED 2', 'LED 3', 'LED 4', 'LED 5', 'LED 6'];
const PULSE_LEDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const CORE_LEN = 20000, PULSE_LEN = 40000, PULSE_RATE = 8000;

// LEDs show linear light, screens are gamma-encoded. This makes dim values look dim but visible.
const toScreen = (v) => Math.round(255 * Math.pow(v / 255, 1 / 2.2));
const css = (c) => `rgb(${toScreen(c[0])},${toScreen(c[1])},${toScreen(c[2])})`;
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function initPreviewTab({ $, el }) {
  let family = 'core';
  const S = { core: structuredClone(core.DEFAULTS), pulse: { ...pulse.DEFAULTS } };
  let t = 0, playing = true, speed = 1, last = null, pulseRun = null, pulseDirty = true, pulseStage1 = null;

  const lensEls = [];

  function buildBoard() {
    const names = family === 'core' ? CORE_LEDS : PULSE_LEDS;
    const board = $('pvBoard');
    board.replaceChildren();
    board.dataset.count = names.length;
    lensEls.length = 0;
    names.forEach((n) => {
      const lens = el('div', { class: 'pv-lens' });
      lensEls.push(lens);
      board.append(el('div', { class: 'pv-led' }, lens, el('span', { text: n })));
    });
  }

  function buildFields() {
    const box = $('pvFields');
    box.replaceChildren();
    const fields = family === 'core' ? CORE_FIELDS : PULSE_FIELDS;
    for (const [key, label, min, max] of fields) {
      const input = el('input', { type: 'number', min, max, step: 1, value: S[family][key] });
      input.addEventListener('input', () => {
        const v = Math.min(max, Math.max(min, Math.round(Number(input.value))));
        if (!Number.isFinite(v)) return;
        S[family][key] = v;
        changed();
      });
      box.append(el('label', { class: 'pv-field' }, el('span', { text: label }), input));
    }
    for (const [key, label] of family === 'core' ? CORE_COLOURS : PULSE_COLOURS) {
      const input = el('input', { type: 'color', value: toHex(S[family][key]) });
      input.addEventListener('input', () => { S[family][key] = fromHex(input.value); changed(); });
      box.append(el('label', { class: 'pv-field' }, el('span', { text: label }), input));
    }
  }

  // ---- what the lights do at time t (ms since the drive got power)
  function pulseFrame(ms) {
    if (pulseDirty) {
      pulseDirty = false;
      if (!pulseStage1) {
        const demo = pulse.synthDnb(PULSE_RATE, { bars: 26 });
        const volts = pulse.micVolts(demo.audio, PULSE_RATE, $('pvRoom').value, 1, 7);
        pulseStage1 = pulse.stage1(volts, PULSE_RATE);
      }
      pulseRun = pulse.stage2(pulseStage1, S.pulse);
    }
    const n = pulseStage1.n;
    const i = Math.min(n - 1, Math.max(0, Math.round((ms - pulseRun.startMs) / pulse.BLOCK_MS) - 1));
    const out = [];
    for (let k = 0; k < 8; k++) out.push([...pulseRun.leds.subarray(i * 24 + k * 3, i * 24 + k * 3 + 3)]);
    return out;
  }
  const length = () => (family === 'core' ? CORE_LEN : Math.min(PULSE_LEN, pulseStage1 ? pulseStage1.t[pulseStage1.n - 1] * 1000 : PULSE_LEN));
  const frameAt = (ms) => (family === 'core' ? core.render(S.core, Math.floor(ms / 10) * 10) : pulseFrame(ms));

  function note() {
    if (family === 'core') {
      const ramp = core.motorStartMs(S.core);
      $('pvNote').textContent = `Core, ${(S.core.WHITE_MS / 1000).toFixed(1)} s white glow, then fade to red. LEDs 3 and 4 do the motor-start stutter for ${(ramp / 1000).toFixed(1)} s, then pulse red. Other LEDs brighten over the same time.`;
    } else {
      $('pvNote').textContent = 'Pulse, with a drum and bass demo played through a simulated microphone. It starts with the rise, then the lights follow the kicks and snares and settle to the tempo grid.';
    }
  }

  function drawStrip() {
    const cv = $('pvStrip');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const len = length();
    const rows = family === 'core' ? [0, 2] : [0, 2, 4]; // outer / inner, or bottom / middle / top
    const rh = h / rows.length;
    if (family === 'pulse' && pulseDirty) frameAt(0);
    for (let x = 0; x < w; x++) {
      const px = frameAt(Math.floor((x / w) * len));
      rows.forEach((led, r) => { ctx.fillStyle = css(px[led]); ctx.fillRect(x, r * rh, 1, Math.ceil(rh)); });
    }
    $('pvRows').textContent = family === 'core' ? 'Top row LEDs 1, 2, 5, 6 · bottom row LEDs 3, 4' : 'Rows from top: bottom, middle and top sections of the drive';
  }

  function draw() {
    const len = length();
    if (t > len) t = 0;
    const px = frameAt(t);
    px.forEach((c, i) => {
      lensEls[i].style.background = Math.max(...c) === 0 ? '' : css(c);
      lensEls[i].style.boxShadow = Math.max(...c) === 0 ? '' : `0 0 ${8 + 18 * Math.max(...c) / 255}px ${css(c)}`;
    });
    $('pvClock').textContent = `${(t / 1000).toFixed(2)} s`;
    $('pvScrub').value = String(Math.round((t / len) * 1000));
  }

  function changed() { pulseDirty = true; note(); drawStrip(); draw(); }

  function setFamily(f) {
    family = f;
    for (const k of ['core', 'pulse']) $(`pvFam-${k}`).setAttribute('aria-checked', String(k === f));
    $('pvRoomWrap').hidden = f !== 'pulse';
    t = 0; last = null;
    buildBoard(); buildFields();
    pulseDirty = true;
    if (f === 'pulse' && !pulseStage1) frameAt(0);
    note(); drawStrip(); draw();
  }

  function tick(now) {
    if (playing) {
      if (last !== null) t += (now - last) * speed;
      last = now;
      if (!$('p-routines').hidden) draw();
    } else last = null;
    requestAnimationFrame(tick);
  }

  $('pvFam-core').addEventListener('click', () => setFamily('core'));
  $('pvFam-pulse').addEventListener('click', () => setFamily('pulse'));
  $('pvPlay').addEventListener('click', () => { playing = !playing; $('pvPlay').textContent = playing ? 'Pause' : 'Play'; });
  $('pvRestart').addEventListener('click', () => { t = 0; last = null; draw(); });
  $('pvSpeed').addEventListener('change', () => { speed = Number($('pvSpeed').value); });
  $('pvScrub').addEventListener('input', () => { t = (Number($('pvScrub').value) / 1000) * length(); last = null; draw(); });
  $('pvReset').addEventListener('click', () => {
    S[family] = family === 'core' ? structuredClone(core.DEFAULTS) : { ...pulse.DEFAULTS };
    buildFields(); changed();
  });
  $('pvRoom').addEventListener('change', () => { pulseStage1 = null; changed(); });

  $('t-routines').addEventListener('click', () => { drawStrip(); draw(); }); // the strip can't be sized while hidden
  window.addEventListener('resize', () => { if (!$('p-routines').hidden) drawStrip(); });
  setFamily('core');
  requestAnimationFrame(tick);
}
