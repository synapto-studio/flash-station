// The Routines tab: live previews of what a Core or a Pulse drive's lights will do, using the
// same maths as the firmware (js/preview-core.js, js/preview-pulse.js). No audio, no hardware.
// Pulse plays a built-in drum and bass demo through the simulated mic. Next to today's engine,
// the new player (js/player.js) plays the same look rebuilt as recipes (js/animations.js). The
// Animation lab (js/lab-tab.js) plays recipes pasted from a Claude session.

import * as core from './preview-core.js';
import * as pulse from './preview-pulse.js';
import { makePalette, applyPalette } from './palettes.js';
import { PHASES, makePhaseFile, applyPhaseFile, toEngineNames } from './phases.js';
import { ROUTINE_PHASES, makeRoutine, engineToPreview } from './routines.js';
import { defaultProfile, makeProfile, drawnLeds, groupOf } from './profiles.js';
import { resolveRoutine } from './library.js';
import { Show, makeDrive, pack } from './player.js';
import { coreEngine, coreDrift, pulseStartup, pulseAmbient, heartbeat, heartbeatToday, pulseMusic } from './animations.js';
import { initAnimationLab } from './lab-tab.js';
import { initSongMoments } from './moments-tab.js';
import { initLightCues } from './cues-tab.js';

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

  const lensEls = [], lensEls2 = [];
  let playerShow = null, lab = null, moments = null, cues = null;

  // One side of the drive, front view, drawn from the drive profile (js/profiles.js): y is mm above
  // the top of the USB A connector, x is mm from the centre line. The profile lists only LEDs whose
  // position is known; `led` is the LED number (1-based): change it in the profile if the front is the other side.
  const profile = { core: defaultProfile('core'), pulse: defaultProfile('pulse') };
  const MM = 4.5, PLUG_H = 14, PLUG_W = 12, BOARD_W = 16, TOP_PAD = 8; // px per mm, mm

  function buildBoard() {
    buildBoardIn($('rtBoard'), lensEls);
    buildBoardIn($('rtBoard2'), lensEls2);
    playerShow = null;
    if (lab) lab.refresh();
    if (moments) moments.reload();
    if (cues) cues.reload();
  }
  function buildBoardIn(board, lensEls) {
    const spots = drawnLeds(profile[family]);
    const topY = Math.max(...spots.map((q) => q.y)) + TOP_PAD;
    board.replaceChildren();
    board.style.height = `${(topY + PLUG_H) * MM}px`;
    lensEls.length = 0;
    const pcb = el('div', { class: 'rt-pcb' });
    pcb.style.cssText = `width:${BOARD_W * MM}px;height:${topY * MM}px;top:0`;
    const plug = el('div', { class: 'rt-plug' });
    plug.style.cssText = `width:${PLUG_W * MM}px;height:${PLUG_H * MM}px;top:${topY * MM}px`;
    board.append(pcb, plug);
    for (const q of spots) {
      const lens = el('div', { class: 'rt-lens' });
      lens.style.cssText = `left:calc(50% + ${q.x * MM}px);top:${(topY - q.y) * MM}px`;
      const g = groupOf(profile[family], q.led);
      lens.title = `LED ${q.led}${g ? ` (${g})` : ''}`;
      lensEls[q.led - 1] = lens;
      board.append(lens);
    }
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
  // ---- the same look from the new player: Engine + Drift (Core), start-up + ambient (Pulse)
  function player() {
    if (playerShow) return playerShow;
    const drive = makeDrive(profile[family]);
    if (family === 'core') {
      const C = S.core;
      playerShow = new Show({ sections: [coreEngine(C), coreDrift(C)], drive, colours: { red: C.RED, orange: C.ORANGE, white: C.WHITE, yellow: C.YELLOW }, brightness: C.BRIGHTNESS });
    } else {
      if (pulseDirty) frameAt(0);
      const P = S.pulse;
      playerShow = new Show({ sections: [pulseStartup(P), pulseAmbient(P)], drive, colours: { red: P.red, orange: P.orange, white: P.white }, brightness: P.brightness, music: pulseMusic(pulseRun, pulseStage1) });
    }
    return playerShow;
  }
  function playerFrameAt(ms) {
    try {
      if (family === 'core') return player().frame(Math.floor(ms / 10) * 10);
      const show = player(), n = pulseStage1.n;
      const i = Math.min(n - 1, Math.max(0, Math.round((ms - pulseRun.startMs) / pulse.BLOCK_MS) - 1));
      return show.frame(pulseStage1.now[i] - pulseRun.startMs);
    } catch (e) { return Array.from({ length: family === 'core' ? 6 : 8 }, () => [0, 0, 0]); }
  }
  function playerNote() {
    try {
      if (family === 'core') {
        const e = pack(coreEngine(S.core)).length, d = pack(coreDrift(S.core)).length;
        $('rtPlayerNote').textContent = `New player: Engine (start-up) is ${e} bytes and Drift (ambient) ${d} bytes. With the 4 colours, brightness and layout byte that's ${e + d + 14} of the 98 bytes Core has for settings.`;
      } else {
        const a = pack(pulseStartup(S.pulse)).length, b = pack(pulseAmbient(S.pulse)).length;
        $('rtPlayerNote').textContent = `New player: start-up is ${a} bytes and ambient ${b} bytes. The rainbow on the back LEDs 4 and 6 is a shade off today's (the front, drawn here, matches).`;
      }
    } catch (e) { $('rtPlayerNote').textContent = `New player: ${e.message}`; }
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

  function stripOn(cv, len, frameFn, rows) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const rh = h / rows.length;
    for (let x = 0; x < w; x++) {
      const px = frameFn(Math.floor((x / w) * len));
      rows.forEach((led, r) => { ctx.fillStyle = css(px[led]); ctx.fillRect(x, r * rh, 1, Math.ceil(rh)); });
    }
  }
  function drawStrip() {
    const len = length();
    const rows = family === 'core' ? [2, 0] : [4, 2, 0]; // top of the drive first
    if (family === 'pulse' && pulseDirty) frameAt(0);
    stripOn($('rtStrip'), len, frameAt, rows);
    stripOn($('rtStrip2'), len, playerFrameAt, rows);
    playerNote();
    // the plug-in heartbeat, one whole loop
    const drive = makeDrive(profile[family]), hb = new Show({ sections: [heartbeat()], drive });
    stripOn($('rtHbToday'), 38600, (ms) => heartbeatToday(ms, drive.heights), rows);
    stripOn($('rtHbPlayer'), 38600, (ms) => hb.frame(ms), rows);
    $('rtHbNote').textContent = `Heartbeat recipe: ${pack(heartbeat()).length} bytes. The preview's sparkle (±8 levels in the flow) isn't in the recipe.`;
    $('rtRows').textContent = family === 'core' ? 'Timeline rows, top of the drive first: the upper LED, then the lower pair.' : 'Timeline rows, top of the drive first: top, middle, then the bottom pair.';
  }

  // Lights the drawn LEDs: px is each LED's [r, g, b].
  const light = (els, px) => px.forEach((c, i) => {
    if (!els[i]) return;
    els[i].style.background = Math.max(...c) === 0 ? '' : css(c);
    els[i].style.boxShadow = Math.max(...c) === 0 ? '' : `0 0 ${8 + 18 * Math.max(...c) / 255}px ${css(c)}`;
  });
  function draw() {
    const len = length();
    if (t > len) t = 0;
    light(lensEls, frameAt(t));
    light(lensEls2, playerFrameAt(t));
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

  // ---- drive profile (library casings/ folder): LED count, groups and each LED's position
  function profMsg(text) { $('rtProfMsg').textContent = text; }
  function buildProfileEditor() {
    const p = profile[family];
    const box = $('rtProfLeds');
    box.replaceChildren();
    for (const l of drawnLeds(p)) {
      const g = groupOf(p, l.led);
      const pos = (key, label) => {
        const input = el('input', { type: 'number', step: 0.5, value: l[key], 'aria-label': `LED ${l.led} ${label}` });
        input.addEventListener('input', () => {
          const v = Number(input.value);
          if (input.value === '' || !Number.isFinite(v)) return;
          l[key] = v;
          buildBoard(); draw();
        });
        return input;
      };
      box.append(el('div', { class: 'rt-field' }, el('span', { text: `LED ${l.led}${g ? `, ${g}` : ''}` }), pos('x', 'across (mm)'), pos('y', 'above the plug (mm)')));
    }
    $('rtProfNote').textContent = `${p.count} LEDs on this board. ${p.estimate ? 'These positions are estimates until you save a profile for the casing.' : ''} Across is mm from the centre (left is negative); above the plug is mm from the top of the USB A connector up towards the logo.`;
  }
  async function loadProfiles(pick) {
    const lib = state.library;
    const sel = $('rtProfSel');
    sel.replaceChildren(el('option', { value: '', text: 'Estimated positions' }));
    $('rtProfSave').disabled = !lib;
    const found = lib ? await lib.profiles(family) : [];
    found.forEach((x) => sel.append(el('option', { value: x.name, text: x.name })));
    sel._profiles = found;
    if (pick) { sel.value = pick; if (sel.value !== pick) sel.value = ''; }
  }
  function useProfile() {
    const sel = $('rtProfSel');
    const found = (sel._profiles || []).find((x) => x.name === sel.value);
    profile[family] = found ? structuredClone(found) : defaultProfile(family);
    buildProfileEditor(); buildBoard(); draw();
  }

  function changed() { pulseDirty = true; playerShow = null; note(); drawStrip(); draw(); if (lab) lab.refresh(); if (moments) moments.redraw(); if (cues) cues.refresh(); }

  function setFamily(f) {
    family = f;
    for (const k of ['core', 'pulse']) $(`rtFam-${k}`).setAttribute('aria-checked', String(k === f));
    $('rtRoomWrap').hidden = f !== 'pulse';
    t = 0; last = null;
    buildBoard(); buildFields(); buildProfileEditor();
    pulseDirty = true;
    if (f === 'pulse' && !pulseStage1) frameAt(0);
    note(); drawStrip(); draw(); loadPalettes().catch(() => {}); loadPhaseFiles().catch(() => {}); loadRoutines().catch(() => {});
    loadProfiles().then(useProfile).catch(() => {});
    if (lab) lab.reload();
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
      await loadPalettes(p.name); await loadRoutines(); lab.reload(); moments.reload();
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
      const next = engineToPreview(family, S[family], resolved);
      S[family] = next;
      buildFields(); changed();
      rtMsg(`Showing "${r.data.name}".`);
    } catch (e) { rtMsg(e.message); }
  });
  $('rtProfSel').addEventListener('change', () => { profMsg(''); useProfile(); });
  $('rtProfSave').addEventListener('click', async () => {
    try {
      const p = makeProfile(family, $('rtProfName').value, profile[family]);
      await state.library.saveProfile(p);
      $('rtProfName').value = '';
      await loadProfiles(p.name); useProfile();
      profMsg(`Saved "${p.name}"${state.library.saved ? '' : ' (demo library: lost when you close the page)'}. Put ${p.name} in the casing box when you initialise a drive to use it.`);
    } catch (e) { profMsg(e.message); }
  });
  $('rtRoom').addEventListener('change', () => { pulseStage1 = null; changed(); });

  $('t-routines').addEventListener('click', () => { drawStrip(); draw(); loadProfiles(($('rtProfSel') || {}).value).catch(() => {}); loadPalettes().catch(() => {}); loadPhaseFiles().catch(() => {}); loadRoutines().catch(() => {}); lab.reload(); moments.reload(); cues.reload(); }); // the strip can't be sized while hidden
  window.addEventListener('resize', () => { if (!$('p-routines').hidden) { drawStrip(); lab.redrawStrip(); moments.redraw(); cues.redraw(); } });
  lab = initAnimationLab({ $, el, state, tab: { family: () => family, setFamily, settings: (f) => S[f], profile: () => profile[family], buildBoard: buildBoardIn, stripOn, light } });
  moments = initSongMoments({ $, el, state, tab: { family: () => family, settings: (f) => S[f], profile: () => profile[family], buildBoard: buildBoardIn, light } });
  cues = initLightCues({ $, el, state, tab: { family: () => family, settings: (f) => S[f], profile: () => profile[family], buildBoard: buildBoardIn, stripOn, light, moments, lab } });
  setFamily('core');
  requestAnimationFrame(tick);
}
