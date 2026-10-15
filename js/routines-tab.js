// The Routines tab: live previews of what a Core or a Pulse drive's lights will do, using the
// same maths as the firmware (js/preview-core.js, js/preview-pulse.js). No audio, no hardware.
// Pulse plays a built-in drum and bass demo through the simulated mic.

import * as core from './preview-core.js';
import * as pulse from './preview-pulse.js';
import { makePalette, applyPalette } from './palettes.js';
import { PHASES, makePhaseFile, applyPhaseFile, toEngineNames, fromEngineNames } from './phases.js';
import { ROUTINE_PHASES, makeRoutine } from './routines.js';
import { resolveRoutine } from './library.js';

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

export function initRoutinesTab({ $, el, state }) {
  let family = 'core';
  const S = { core: structuredClone(core.DEFAULTS), pulse: { ...pulse.DEFAULTS } };
  let t = 0, playing = true, speed = 1, last = null, pulseRun = null, pulseDirty = true, pulseStage1 = null;

  const lensEls = [];

  function buildBoard() {
    const names = family === 'core' ? CORE_LEDS : PULSE_LEDS;
    const board = $('rtBoard');
    board.replaceChildren();
    board.dataset.count = names.length;
    lensEls.length = 0;
    names.forEach((n) => {
      const lens = el('div', { class: 'rt-lens' });
      lensEls.push(lens);
      board.append(el('div', { class: 'rt-led' }, lens, el('span', { text: n })));
    });
  }

  function buildFields() {
    const box = $('rtFields');
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
      box.append(el('label', { class: 'rt-field' }, el('span', { text: label }), input));
    }
    for (const [key, label] of family === 'core' ? CORE_COLOURS : PULSE_COLOURS) {
      const input = el('input', { type: 'color', value: toHex(S[family][key]) });
      input.addEventListener('input', () => { S[family][key] = fromHex(input.value); changed(); });
      box.append(el('label', { class: 'rt-field' }, el('span', { text: label }), input));
    }
  }

  // ---- what the lights do at time t (ms since the drive got power)
  function pulseFrame(ms) {
    if (pulseDirty) {
      pulseDirty = false;
      if (!pulseStage1) {
        const demo = pulse.synthDnb(PULSE_RATE, { bars: 26 });
        const volts = pulse.micVolts(demo.audio, PULSE_RATE, $('rtRoom').value, 1, 7);
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
      $('rtNote').textContent = `Core, ${(S.core.WHITE_MS / 1000).toFixed(1)} s white glow, then fade to red. LEDs 3 and 4 do the motor-start stutter for ${(ramp / 1000).toFixed(1)} s, then pulse red. Other LEDs brighten over the same time.`;
    } else {
      $('rtNote').textContent = 'Pulse, with a drum and bass demo played through a simulated microphone. It starts with the rise, then the lights follow the kicks and snares and settle to the tempo grid.';
    }
  }

  function drawStrip() {
    const cv = $('rtStrip');
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
    $('rtRows').textContent = family === 'core' ? 'Top row LEDs 1, 2, 5, 6 · bottom row LEDs 3, 4' : 'Rows from top: bottom, middle and top sections of the drive';
  }

  function draw() {
    const len = length();
    if (t > len) t = 0;
    const px = frameAt(t);
    px.forEach((c, i) => {
      lensEls[i].style.background = Math.max(...c) === 0 ? '' : css(c);
      lensEls[i].style.boxShadow = Math.max(...c) === 0 ? '' : `0 0 ${8 + 18 * Math.max(...c) / 255}px ${css(c)}`;
    });
    $('rtClock').textContent = `${(t / 1000).toFixed(2)} s`;
    $('rtScrub').value = String(Math.round((t / len) * 1000));
  }

  // ---- saved colour sets (library palettes/ folder)
  async function loadPalettes(pick) {
    const lib = state.library;
    const sel = $('rtPalSel');
    sel.replaceChildren(el('option', { value: '', text: lib ? 'Choose a colour set' : 'No library folder' }));
    $('rtPalSave').disabled = !lib;
    if (!lib) { sel.disabled = true; $('rtPalUse').disabled = true; return; }
    const sets = await lib.palettes(family);
    sets.forEach((p) => sel.append(el('option', { value: p.name, text: p.name })));
    sel.disabled = $('rtPalUse').disabled = !sets.length;
    sel._sets = sets;
    if (pick) sel.value = pick;
  }
  function palMsg(text) { $('rtPalMsg').textContent = text; }

  // ---- phase files (library phases/ folder)
  async function loadPhaseFiles(pick) {
    const lib = state.library;
    const sel = $('rtPhFile');
    sel.replaceChildren(el('option', { value: '', text: lib ? 'Choose a phase file' : 'No library folder' }));
    $('rtPhSave').disabled = !lib;
    const files = lib ? await lib.phaseFiles(family, $('rtPhSel').value) : [];
    files.forEach((p, i) => sel.append(el('option', { value: String(i), text: `${p.name} v${p.version}` })));
    sel.disabled = $('rtPhUse').disabled = !files.length;
    sel._files = files;
    if (pick !== undefined) sel.value = String(pick);
  }
  function phMsg(text) { $('rtPhMsg').textContent = text; }

  // ---- routines (library routines/ folder): one phase file per phase, a colour set, a brightness
  const rtPhaseSel = {};
  ROUTINE_PHASES.forEach((p) => {
    const sel = el('select', {});
    rtPhaseSel[p.id] = sel;
    $('rtRtPhases').append(el('label', {}, `${p.label} `, sel));
  });
  function rtMsg(text) { $('rtRtMsg').textContent = text; }
  async function loadRoutines(pick) {
    const lib = state.library;
    $('rtRtSave').disabled = !lib;
    const files = lib ? await lib.phaseFiles(family) : [];
    for (const p of ROUTINE_PHASES) {
      const sel = rtPhaseSel[p.id], keep = sel.value;
      sel.replaceChildren(el('option', { value: '', text: 'Engine default' }));
      const mine = files.filter((f) => f.phase === p.id);
      for (const name of [...new Set(mine.map((f) => f.name))]) {
        sel.append(el('option', { value: name, text: `${name} (newest)` }));
        mine.filter((f) => f.name === name).forEach((f) => sel.append(el('option', { value: `${name}@${f.version}`, text: `${name} v${f.version} only` })));
      }
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
    }
    const pal = $('rtRtPal'), keepPal = pal.value;
    pal.replaceChildren(el('option', { value: '', text: 'Engine default' }));
    const sets = lib ? await lib.palettes(family) : [];
    sets.forEach((x) => pal.append(el('option', { value: x.name, text: x.name })));
    pal._sets = sets;
    pal.value = [...pal.options].some((o) => o.value === keepPal) ? keepPal : '';
    const sel = $('rtRtSel');
    sel.replaceChildren(el('option', { value: '', text: lib ? 'Choose a routine' : 'No library folder' }));
    const routines = lib ? await lib.routines(family) : [];
    routines.forEach((r) => sel.append(el('option', { value: r.data.name, text: r.data.name })));
    sel._routines = routines;
    sel.disabled = $('rtRtLoad').disabled = !routines.length;
    if (pick) sel.value = pick;
  }
  function routineInput() {
    const phases = Object.fromEntries(ROUTINE_PHASES.map((p) => [p.id, rtPhaseSel[p.id].value]));
    const palette = ($('rtRtPal')._sets || []).find((x) => x.name === $('rtRtPal').value) || null;
    const b = $('rtRtBright').value.trim();
    return { phases, palette, brightness: b === '' ? null : Number(b) };
  }

  function changed() { pulseDirty = true; note(); drawStrip(); draw(); }

  function setFamily(f) {
    family = f;
    for (const k of ['core', 'pulse']) $(`rtFam-${k}`).setAttribute('aria-checked', String(k === f));
    $('rtRoomWrap').hidden = f !== 'pulse';
    t = 0; last = null;
    buildBoard(); buildFields();
    pulseDirty = true;
    if (f === 'pulse' && !pulseStage1) frameAt(0);
    note(); drawStrip(); draw(); loadPalettes().catch(() => {}); loadPhaseFiles().catch(() => {}); loadRoutines().catch(() => {});
  }

  function tick(now) {
    if (playing) {
      if (last !== null) t += (now - last) * speed;
      last = now;
      if (!$('p-routines').hidden) draw();
    } else last = null;
    requestAnimationFrame(tick);
  }

  $('rtFam-core').addEventListener('click', () => setFamily('core'));
  $('rtFam-pulse').addEventListener('click', () => setFamily('pulse'));
  $('rtPlay').addEventListener('click', () => { playing = !playing; $('rtPlay').textContent = playing ? 'Pause' : 'Play'; });
  $('rtRestart').addEventListener('click', () => { t = 0; last = null; draw(); });
  $('rtSpeed').addEventListener('change', () => { speed = Number($('rtSpeed').value); });
  $('rtScrub').addEventListener('input', () => { t = (Number($('rtScrub').value) / 1000) * length(); last = null; draw(); });
  $('rtReset').addEventListener('click', () => {
    S[family] = family === 'core' ? structuredClone(core.DEFAULTS) : { ...pulse.DEFAULTS };
    buildFields(); changed();
  });
  $('rtPalUse').addEventListener('click', () => {
    const p = ($('rtPalSel')._sets || []).find((x) => x.name === $('rtPalSel').value);
    if (!p) return palMsg('Choose a colour set first.');
    S[family] = applyPalette(family, S[family], p);
    buildFields(); changed();
    palMsg(`Using "${p.name}".`);
  });
  $('rtPalSave').addEventListener('click', async () => {
    try {
      const p = makePalette(family, $('rtPalName').value, S[family]);
      await state.library.savePalette(p);
      $('rtPalName').value = '';
      await loadPalettes(p.name); await loadRoutines();
      palMsg(`Saved "${p.name}"${state.library.saved ? '' : ' (demo library: lost when you close the page)'}.`);
    } catch (e) { palMsg(e.message); }
  });
  PHASES.forEach((p) => $('rtPhSel').append(el('option', { value: p.id, text: p.label })));
  $('rtPhSel').addEventListener('change', () => { phMsg(''); loadPhaseFiles().catch(() => {}); loadRoutines().catch(() => {}); });
  $('rtPhUse').addEventListener('click', () => {
    const f = ($('rtPhFile')._files || [])[Number($('rtPhFile').value)];
    if (!f || $('rtPhFile').value === '') return phMsg('Choose a phase file first.');
    S[family] = applyPhaseFile(family, S[family], f);
    buildFields(); changed();
    phMsg(`Using "${f.name}" v${f.version}.`);
  });
  $('rtPhSave').addEventListener('click', async () => {
    try {
      const saved = await state.library.savePhaseFile(makePhaseFile(family, $('rtPhSel').value, $('rtPhName').value, S[family]));
      $('rtPhName').value = '';
      await loadPhaseFiles(); await loadRoutines();
      phMsg(`Saved "${saved.name}" v${saved.version}${state.library.saved ? '' : ' (demo library: lost when you close the page)'}.`);
    } catch (e) { phMsg(e.message); }
  });
  $('rtRtSave').addEventListener('click', async () => {
    try {
      const r = makeRoutine(family, $('rtRtName').value, routineInput());
      await state.library.saveRoutine(r);
      state.routines = await state.library.routines();
      $('rtRtName').value = '';
      await loadRoutines(r.name);
      rtMsg(`Saved "${r.name}"${state.library.saved ? '' : ' (demo library: lost when you close the page)'}.`);
    } catch (e) { rtMsg(e.message); }
  });
  $('rtRtLoad').addEventListener('click', async () => {
    const r = ($('rtRtSel')._routines || []).find((x) => x.data.name === $('rtRtSel').value);
    if (!r) return rtMsg('Choose a routine first.');
    try {
      const resolved = await resolveRoutine(state.library, r.data, toEngineNames(family, S[family]));
      let next = fromEngineNames(family, S[family], resolved);
      if (family === 'core') for (const k of ['WHITE', 'RED', 'YELLOW', 'ORANGE']) if (resolved[k.toLowerCase()]) next[k] = [...resolved[k.toLowerCase()]];
      if (resolved.brightness != null) next[family === 'core' ? 'BRIGHTNESS' : 'brightness'] = resolved.brightness;
      S[family] = next;
      buildFields(); changed();
      rtMsg(`Showing "${r.data.name}".`);
    } catch (e) { rtMsg(e.message); }
  });
  $('rtRoom').addEventListener('change', () => { pulseStage1 = null; changed(); });

  $('t-routines').addEventListener('click', () => { drawStrip(); draw(); loadPalettes().catch(() => {}); loadPhaseFiles().catch(() => {}); loadRoutines().catch(() => {}); }); // the strip can't be sized while hidden
  window.addEventListener('resize', () => { if (!$('p-routines').hidden) drawStrip(); });
  setFamily('core');
  requestAnimationFrame(tick);
}
