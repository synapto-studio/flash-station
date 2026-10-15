// The Preview tab: plays the Core (coretest) and Pulse (pulsetest) lighting in the browser,
// using the same maths as the firmware (preview-core.js, preview-pulse.js).

import { CORE_DEFAULTS, PULSE_DEFAULTS } from './demo.js';
import * as core from './preview-core.js';
import * as pulse from './preview-pulse.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
// LEDs show linear light, screens are gamma-encoded: convert so dim values look dim but visible.
const toScreen = (v) => Math.round(255 * Math.pow(v / 255, 1 / 2.2));
const css = (c) => `rgb(${toScreen(c[0])},${toScreen(c[1])},${toScreen(c[2])})`;
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// [key, label, unit/hint, min, max, step]. Colours are listed apart.
const CORE_FIELDS = [
  ['brightness', 'Overall brightness', '0–255', 1, 255, 5],
  ['startupDim', 'Start-up brightness', '0–255', 0, 255, 5],
  ['whiteMs', 'White glow', 'ms', 0, 3000, 50],
  ['whiteToRedMs', 'White to red fade', 'ms', 100, 4000, 100],
  ['colourStepMs', 'Each colour fade (×3 = loop)', 'ms', 200, 20000, 250],
  ['breatheMs', 'Red pulse length', 'ms', 400, 20000, 250],
  ['breatheMin', 'Red pulse dimmest', '0–255', 0, 250, 5],
];
const CORE_COLOURS = [['white', 'White glow'], ['red', 'Red'], ['yellow', 'Yellow'], ['orange', 'Orange']];
const PULSE_FIELDS = [
  ['riseMs', 'Glow rises up the drive', 'ms', 100, 6000, 50],
  ['topPulseMs', 'Top pulses white', 'ms', 0, 6000, 50],
  ['topPulses', 'Number of white pulses', '', 1, 12, 1],
  ['multiMs', 'Top goes multicoloured', 'ms', 0, 8000, 100],
  ['pourMs', 'Colours pour down', 'ms', 100, 6000, 50],
  ['whiteMs', 'Everything turns white', 'ms', 100, 8000, 100],
  ['drainMs', 'White drains into the plug', 'ms', 100, 6000, 50],
  ['flowMs', 'Red flows up out of the plug', 'ms', 100, 6000, 50],
  ['glowLevel', 'Rising glow brightness', '0–255', 0, 255, 5],
  ['bottomLevel', 'Bottom brightness', '0–255', 0, 255, 5],
  ['cycleBars', 'Bottom cycle length', 'bars', 1, 64, 1],
  ['middleLevel', 'Middle brightness', '0–255', 0, 255, 5],
  ['topHigh', 'Top pulse brightest', '0–255', 0, 255, 5],
  ['topLow', 'Top pulse dimmest', '0–255', 0, 255, 5],
  ['brightness', 'Overall brightness', '0–255', 1, 255, 5],
  ['loudTop', 'Top reacts from', 'dB SPL', 50, 130, 1],
  ['loudMiddle', 'Middle joins in from', 'dB SPL', 50, 130, 1],
  ['loudBottom', 'Bottom joins in from', 'dB SPL', 50, 130, 1],
  ['kickFadeMs', 'Surge fade', 'ms', 20, 2000, 10],
  ['kickMin', 'Smallest surge', '0–255', 0, 255, 5],
  ['bpmX10', 'Starting tempo', 'BPM × 10', 600, 2500, 5],
  ['leadMs', 'Pulse early by', 'ms', 0, 200, 5],
];
const PULSE_COLOURS = [['white', 'White'], ['red', 'Red'], ['orange', 'Orange']];
const PULSE_STEPS = ['Glow rises up the drive', 'Top pulses white', 'Top goes multicoloured', 'Colours pour down',
  'Everything turns white', 'White drains into the plug', 'Red flows up out of the plug'];
// Pulse LED positions (index = LED number - 1): rows from the top of the drive to the plug.
const PULSE_ROWS = [['Top', [4, 5]], ['Middle', [2, 3]], ['Bottom', [1, 6, 0, 7]]];
const PULSE_STRIPS = [['Top', 4], ['Middle', 2], ['Bottom', 0]];

export function initPreviewTab({ $ }) {
  let board = 'core';
  let S = clone(CORE_DEFAULTS);
  let t = 0, playing = true, speed = 1, last = null;
  let dur = core.TIMELINE_MS / 1000; // seconds
  let st = null, res = null; // pulse analysis (stage 1) and result (stage 2)
  let pulseStatus = '', pulseBusy = false;
  let demo = null;
  let leds = [];

  const stage = $('pvLeds');
  const defaults = () => (board === 'core' ? CORE_DEFAULTS : PULSE_DEFAULTS);
  const fields = () => (board === 'core' ? CORE_FIELDS : PULSE_FIELDS);
  const colours = () => (board === 'core' ? CORE_COLOURS : PULSE_COLOURS);

  // ---------------------------------------------------------------- the drive drawing
  function ledEl(n) {
    const d = document.createElement('div');
    d.className = 'pvled';
    d.innerHTML = '<div class="pvpkg"><div class="pvglow"></div><div class="pvlens"></div></div><div class="pvname"></div>';
    d.querySelector('.pvname').textContent = `LED ${n}`;
    return { root: d, lens: d.querySelector('.pvlens'), glow: d.querySelector('.pvglow') };
  }
  function buildDrive() {
    stage.replaceChildren();
    leds = [];
    if (board === 'core') {
      stage.className = 'pvleds core';
      for (let i = 0; i < 6; i++) { leds[i] = ledEl(i + 1); stage.append(leds[i].root); }
    } else {
      stage.className = 'pvleds pulse';
      for (const [name, idx] of PULSE_ROWS) {
        const sec = document.createElement('div');
        sec.className = 'pvsec';
        const h = document.createElement('div');
        h.className = 'pvsecname';
        h.textContent = name;
        const row = document.createElement('div');
        row.className = 'pvrow';
        for (const i of idx) { leds[i] = ledEl(i + 1); row.append(leds[i].root); }
        sec.append(h, row);
        stage.append(sec);
      }
      const plug = document.createElement('div');
      plug.className = 'pvplug';
      plug.textContent = 'USB plug';
      stage.append(plug);
    }
  }

  // ---------------------------------------------------------------- what the LEDs show at time t (seconds)
  function frameAt(sec) {
    if (board === 'core') return core.render(S, Math.floor((sec * 1000) / core.TICK_MS) * core.TICK_MS);
    if (!res) return null;
    const i = blockAt(sec);
    const out = [];
    for (let L = 0; L < 8; L++) out.push(i < 0 ? [0, 0, 0] : [res.leds[i * 24 + L * 3], res.leds[i * 24 + L * 3 + 1], res.leds[i * 24 + L * 3 + 2]]);
    return out;
  }
  function blockAt(sec) {
    if (!st || st.n === 0 || sec < st.t[0]) return -1;
    let lo = 0, hi = st.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st.t[mid] <= sec) lo = mid; else hi = mid - 1; }
    return lo;
  }

  function draw() {
    const px = frameAt(t);
    if (px) {
      px.forEach((c, i) => {
        const L = leds[i];
        if (!L) return;
        const m = Math.max(...c);
        L.lens.style.background = m === 0 ? '' : css(c);
        L.glow.style.background = css(c);
        L.glow.style.opacity = String(Math.pow(m / 255, 0.6) * 0.9);
        L.root.title = `LED ${i + 1}: ${c.join(', ')}`;
      });
    }
    $('pvClock').textContent = `${t.toFixed(2)} s`;
    if (board === 'core') {
      const p = core.phaseText(S, t * 1000);
      $('pvPhase').innerHTML = '';
      for (const [txt, who] of [[p.outer, 'LEDs 1, 2, 5, 6'], [p.inner, 'LEDs 3, 4']]) {
        const d = document.createElement('div');
        d.textContent = `${txt} · ${who}`;
        $('pvPhase').append(d);
      }
    } else drawPulseReadout();
    const pct = (dur ? Math.min(t, dur) / dur : 0) * 100 + '%';
    for (const ph of document.querySelectorAll('.pvph')) ph.style.left = pct;
  }

  function drawPulseReadout() {
    const phase = $('pvPhase');
    if (!res) { phase.textContent = pulseStatus; return; }
    const i = blockAt(t);
    if (i < 0) { phase.textContent = 'Powering up: the bootloader listens for the station for 0.12 s first.'; return; }
    const ms = st.now[i] - res.startMs;
    let step = -1;
    for (let p = 0; p < 7; p++) if (ms < res.phaseEnds[p]) { step = p; break; }
    phase.textContent = step >= 0 ? `Start-up, step ${step + 1} of 7: ${PULSE_STEPS[step]}` : 'Steady: bottom red ↔ orange, middle dim red, top pulsing once a bar';
    const locked = res.conf[i] >= 4;
    $('pvBpm').textContent = `${res.bpm[i].toFixed(1)} BPM`;
    $('pvLock').textContent = locked ? 'following the music' : res.conf[i] > 0 ? 'finding the beat' : 'its own time';
    $('pvLevel').textContent = `${(res.loud[i] / 16).toFixed(1)} dB SPL`;
    [$('pvChipBot'), $('pvChipMid'), $('pvChipTop')].forEach((chip, s) => chip.classList.toggle('on', step < 0 && res.gains[i * 3 + s] >= 128));
  }

  // ---------------------------------------------------------------- timeline strips
  function buildTracks() {
    const tr = $('pvTracks');
    tr.replaceChildren();
    const strips = board === 'core' ? [['LEDs 1, 2, 5, 6', 0], ['LEDs 3, 4', 2]] : PULSE_STRIPS;
    for (const [name, idx] of strips) {
      const row = document.createElement('div');
      row.className = 'pvtrack';
      row.innerHTML = '<div class="pvtname"></div><div class="pvstrip"><canvas></canvas><div class="pvph"></div></div>';
      row.firstChild.textContent = name;
      row.dataset.led = idx;
      tr.append(row);
    }
  }
  function drawStrips() {
    const ready = board === 'core' || res;
    if (!ready) return;
    const dpr = window.devicePixelRatio || 1;
    for (const row of $('pvTracks').children) {
      const cv = row.querySelector('canvas'), led = Number(row.dataset.led);
      const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      c.fillStyle = '#121010';
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        let px;
        if (board === 'core') px = core.render(S, Math.floor(((x / w) * dur * 1000) / core.TICK_MS) * core.TICK_MS)[led];
        else {
          // the brightest block under this pixel, so short flashes still show
          let a = blockAt((x / w) * dur), b = blockAt(((x + 1) / w) * dur), best = -1, bm = -1;
          if (b < 0) continue;
          if (a < 0) a = 0;
          for (let i = a; i <= b; i++) {
            const o = i * 24 + led * 3, m = res.leds[o] + res.leds[o + 1] + res.leds[o + 2];
            if (m > bm) { bm = m; best = i; }
          }
          const q = best * 24 + led * 3;
          px = [res.leds[q], res.leds[q + 1], res.leds[q + 2]];
        }
        c.fillStyle = css(px);
        c.fillRect(x, 0, 1, h);
      }
      // the line where the start-up ends
      const endMs = board === 'core' ? core.motorStartMs(S) : res.phaseEnds[6] + res.startMs;
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.fillRect(Math.round((endMs / 1000 / dur) * w), 0, Math.max(1, dpr), h);
    }
    const step = dur > 60 ? 30 : dur > 20 ? 5 : 2;
    $('pvTicks').replaceChildren(...Array.from({ length: Math.floor(dur / step) + 1 }, (_, k) => {
      const sp = document.createElement('span');
      sp.style.left = `${((k * step) / dur) * 100}%`;
      sp.textContent = `${k * step} s`;
      return sp;
    }));
    const endS = (board === 'core' ? core.motorStartMs(S) : res.phaseEnds[6] + res.startMs) / 1000;
    $('pvLegend').textContent = board === 'core'
      ? `Each strip is what that group of LEDs shows. The line at ${endS.toFixed(1)} s is where the motor start ends and the steady loop begins. Click or drag to jump.`
      : `Each strip is one section's colour. The line at ${endS.toFixed(1)} s is where the start-up ends and the steady look begins. Click or drag to jump.`;
    draw();
  }

  // ---------------------------------------------------------------- Pulse: listen, then light
  function analyse() {
    if (board !== 'pulse') return;
    const music = $('pvMusic').value, room = $('pvRoom').value;
    res = null; st = null; pulseBusy = true;
    pulseStatus = 'Listening…';
    $('pvStatus').textContent = pulseStatus;
    $('pvPlay').disabled = true;
    draw();
    setTimeout(() => {
      if (board !== 'pulse') return;
      let track;
      if (music === 'demo') { demo = demo || pulse.synthDnb(44100, {}); track = demo.audio; } else track = new Float32Array(44100 * 24);
      const v = pulse.micVolts(track, 44100, music === 'none' ? 'silence' : room, 0, 7);
      st = pulse.stage1(v, 44100, {});
      dur = v.length / 44100;
      pulseBusy = false;
      $('pvPlay').disabled = false;
      $('pvStatus').textContent = music === 'demo'
        ? 'Demo: 174 BPM two-step, breakdown in bars 13–16. Played silently: only the lights are shown.'
        : 'No music: the start-up, then the steady look.';
      rerun();
    }, 20);
  }
  function rerun() {
    if (board !== 'pulse' || !st) return;
    res = pulse.stage2(st, S);
    drawStrips();
  }

  // ---------------------------------------------------------------- tuning
  function buildTune() {
    const root = $('pvTune');
    root.replaceChildren();
    for (const [key, label, hint, min, max, step] of fields()) {
      const lab = document.createElement('label');
      lab.className = 'pvfield';
      const name = document.createElement('span');
      name.textContent = label;
      if (hint) { const s = document.createElement('small'); s.textContent = hint; name.append(' ', s); }
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = min; inp.max = max; inp.step = step; inp.value = S[key];
      inp.dataset.key = key;
      inp.addEventListener('change', () => {
        let v = parseInt(inp.value, 10);
        if (Number.isNaN(v)) v = defaults()[key];
        v = Math.min(Math.max(v, min), max);
        inp.value = v; S[key] = v;
        changed();
      });
      lab.append(name, inp);
      root.append(lab);
    }
    for (const [key, label] of colours()) {
      const lab = document.createElement('label');
      lab.className = 'pvfield';
      const name = document.createElement('span');
      name.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = hex(S[key]); inp.dataset.key = key;
      inp.addEventListener('input', () => { S[key] = unhex(inp.value); changed(); });
      lab.append(name, inp);
      root.append(lab);
    }
    markChanged();
  }
  function markChanged() {
    for (const inp of $('pvTune').querySelectorAll('input')) {
      const k = inp.dataset.key;
      inp.closest('label').classList.toggle('changed', JSON.stringify(S[k]) !== JSON.stringify(defaults()[k]));
    }
  }
  function changed() {
    markChanged();
    if (board === 'core') drawStrips(); else rerun();
  }

  // ---------------------------------------------------------------- switching boards
  function setBoard(b) {
    board = b;
    S = clone(defaults());
    t = 0; last = null; playing = true; $('pvPlay').textContent = 'Pause';
    for (const btn of document.querySelectorAll('.pvboard button')) btn.setAttribute('aria-checked', String(btn.dataset.pv === b));
    for (const e of document.querySelectorAll('.pvonly.pulse')) e.hidden = b !== 'pulse';
    st = null; res = null;
    $('pvStatus').textContent = '';
    $('pvPlay').disabled = false;
    buildDrive(); buildTracks(); buildTune();
    if (b === 'core') { dur = core.TIMELINE_MS / 1000; drawStrips(); } else analyse();
    draw();
  }

  // ---------------------------------------------------------------- playback
  function frame(now) {
    if (playing && !pulseBusy && document.visibilityState !== 'hidden' && !$('p-preview').hidden) {
      if (last !== null) t = Math.min(dur, t + ((now - last) / 1000) * speed);
      last = now;
      if (t >= dur && board === 'pulse') { playing = false; $('pvPlay').textContent = 'Play'; }
      draw();
    } else last = null;
    requestAnimationFrame(frame);
  }
  function setPlaying(p) { playing = p; last = null; $('pvPlay').textContent = p ? 'Pause' : 'Play'; if (!p) draw(); }
  $('pvPlay').addEventListener('click', () => { if (!playing && t >= dur) t = 0; setPlaying(!playing); });
  $('pvPower').addEventListener('click', () => { t = 0; last = null; setPlaying(true); draw(); });
  $('pvSpeed').addEventListener('change', (e) => { speed = parseFloat(e.target.value); });
  $('pvMusic').addEventListener('change', () => { $('pvRoom').disabled = $('pvMusic').value === 'none'; analyse(); });
  $('pvRoom').addEventListener('change', analyse);
  $('pvReset').addEventListener('click', () => { S = clone(defaults()); buildTune(); changed(); });
  for (const btn of document.querySelectorAll('.pvboard button')) btn.addEventListener('click', () => { if (btn.dataset.pv !== board) setBoard(btn.dataset.pv); });

  // click or drag the strips to jump
  const tracksEl = $('pvTracks');
  let dragging = false;
  const scrub = (e) => {
    const r = tracksEl.querySelector('.pvstrip').getBoundingClientRect();
    t = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * dur;
    last = null; draw();
  };
  tracksEl.addEventListener('pointerdown', (e) => { dragging = true; tracksEl.setPointerCapture(e.pointerId); scrub(e); });
  tracksEl.addEventListener('pointermove', (e) => { if (dragging) scrub(e); });
  tracksEl.addEventListener('pointerup', () => { dragging = false; });
  tracksEl.addEventListener('pointercancel', () => { dragging = false; });
  window.addEventListener('resize', drawStrips);

  // the first time the tab opens, draw the strips (they need a real width)
  let shown = false;
  $('t-preview').addEventListener('click', () => { if (!shown) { shown = true; requestAnimationFrame(drawStrips); } });

  setBoard('core');
  requestAnimationFrame(frame);
}
