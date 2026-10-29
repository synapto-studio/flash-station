// Light cues in the Routines tab (R8), Pulse only. Uses the song open in Song moments: press
// Record cues, the song plays from a little before Play at, and each key press (W white pulse,
// B brightness pulse, S shimmer, T stutter, X cut out, F fade up, D fade down; held for as long
// as the cue should last) adds a cue, snapped to the beat grid. The drive drawing shows the cues
// as they're made; Play back plays them with the song. Each cue's LEDs (top, middle, bottom or
// all), colour and brightness can be changed in the list, then the cues are saved as an
// animation (animations/) and picked for the song moment. The maths is js/cues.js.

import { Show, makeDrive } from './player.js';
import { recipeText } from './lab.js';
import { drawnLeds } from './profiles.js';
import * as C from './cues.js';
import * as M from './moments.js';

const TAP_S = 0.3;            // held shorter than this, a key press is a tap (the cue's tap length)
const STORE = 'synapto-cues:'; // + the song's name: that song's cues, kept in this browser
const fmt = M.fmtTime;

export function initLightCues({ $, el, state, tab }) {
  // tab: { family(), settings(f), profile(), buildBoard(box, lensEls), stripOn(cv, len, frameFn, rows), light(lensEls, px), moments, lab }
  let song = null;            // moments.current(): { name, buffer, duration, grid, playAt }
  let start = 0;              // s in the song where the animation starts (on a beat)
  let cues = [];
  let built = null, show = null, buildError = null; // C.build()'s result and its show
  let mode = 'stop';          // 'stop' | 'record' | 'play'
  let actx = null, src = null, srcAt = 0, srcFrom = 0;
  let pos = 0;                // s in the song, while stopped: where the playhead was left
  const held = new Map();     // key -> { kind, at (beats), t0 (song s) }
  const lens = [];
  let rows = [];

  const beatS = () => 60 / song.grid.bpm;
  const beatsAt = (s) => (s - start) / beatS();
  const songNow = () => (src ? srcFrom + (actx.currentTime - srcAt) : pos);
  const snapStep = () => Number($('cqSnap').value) || 0.25;
  const leadBeats = () => Number($('cqLead').value) || 0;
  const level = (id) => Math.max(0, Math.min(100, Number($(id).value) || 0));
  const under = () => ({ colour: C.rgbOf($('cqUnder').value), level: level('cqUnderLevel') });

  // ---------------------------------------------------------------- messages
  function message(kind, ...parts) { const b = $('cqMsg'); b.className = `lab-msg ${kind}`; b.replaceChildren(...parts); }
  const saveMsg = (text) => { $('cqSaveMsg').textContent = text; };

  // ---------------------------------------------------------------- kept in the browser
  function keep() {
    if (!song) return;
    try { localStorage.setItem(STORE + song.name, JSON.stringify({ start, cues, under: under() })); } catch {}
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE + song.name) || 'null'); } catch {}
    cues = C.cleanCues(saved && saved.cues);
    start = saved && Number.isFinite(saved.start) ? saved.start : playAtOrStart();
    if (saved && saved.under && Array.isArray(saved.under.colour)) {
      $('cqUnder').value = C.hex(saved.under.colour);
      $('cqUnderLevel').value = String(saved.under.level);
    }
  }
  const playAtOrStart = () => (song.playAt != null ? song.playAt : M.snapUp(song.grid, Math.max(0, song.grid.firstBar)));

  // ---------------------------------------------------------------- the song from Song moments
  function pickSong() {
    const now = tab.moments.current();
    const same = song && now && now.name === song.name && now.grid.bpm === song.grid.bpm && now.grid.firstBar === song.grid.firstBar;
    if (same) { if (song.playAt !== now.playAt) { song.playAt = now.playAt; status(); } return; }
    stop();
    song = now;
    if (song) restore();
    else cues = [];
    $('cqName').value = song ? `${song.name.replace(/\.[^.]+$/, '')} cues` : '';
    rebuild();
  }

  // ---------------------------------------------------------------- the animation
  function rebuild() {
    built = null; show = null; buildError = null;
    if (song && cues.length) {
      try {
        built = C.build({ name: $('cqName').value.trim() || 'Light cues', cues, under: under(), drive: makeDrive(tab.profile()) });
        show = new Show({ sections: [built.anim], drive: makeDrive(tab.profile()), colours: tab.settings('pulse'), brightness: tab.settings('pulse').brightness, bpm: song.grid.bpm });
      } catch (e) { buildError = e.message; }
    }
    status(); list(); drawStrip(); draw();
    for (const id of ['cqSave', 'cqToLab', 'cqCopy']) $(id).disabled = !built;
    keep();
  }
  // The animation as it plays with the key still down: held cues grow to now.
  function liveShow() {
    if (!held.size || !song) return show;
    const b = beatsAt(songNow());
    const extra = [...held.values()].map((h) => ({ ...newCue(h.kind, h.at), for: Math.max(C.STEP, b - h.at) }));
    try {
      const all = [...cues, ...extra].slice(-C.MAX_CUES);
      const r = C.build({ cues: all, under: under(), drive: makeDrive(tab.profile()) });
      return new Show({ sections: [r.anim], drive: makeDrive(tab.profile()), colours: tab.settings('pulse'), brightness: tab.settings('pulse').brightness, bpm: song.grid.bpm });
    } catch { return show; }
  }
  const totalBeats = () => C.cuesLength(cues);
  const DARK = () => Array.from({ length: 8 }, () => [0, 0, 0]);
  function frameAt(sh, beats) {
    if (!sh || beats < 0) return DARK();
    try { return sh.frame(Math.round(beats * beatS() * 1000)); } catch { return DARK(); }
  }

  // ---------------------------------------------------------------- a new cue
  function newCue(kind, at) {
    const k = C.KINDS[kind];
    return {
      kind, at, for: k.tap, zone: $('cqZone').value,
      colour: k.white ? [255, 255, 255] : C.rgbOf($('cqColour').value),
      level: level('cqLevel'),
    };
  }
  function keyDown(key) {
    if (mode !== 'record' || held.has(key)) return;
    const kind = C.KIND_BY_KEY[key];
    const s = songNow(), at = C.snapTo(beatsAt(s), snapStep());
    if (at < 0) return message('', `That was in the lead-in, before the start (${fmt(start)}). Cues start from there.`);
    if (cues.length + held.size >= C.MAX_CUES) return message('bad', el('strong', { text: `That's ${C.MAX_CUES} cues, the most one animation can have. ` }), 'Delete or undo some, or save these and start another.');
    held.set(key, { kind, at, t0: s });
    flashKey(key, true);
  }
  function keyUp(key) {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    flashKey(key, false);
    const s = songNow(), cue = newCue(h.kind, h.at);
    if (s - h.t0 >= TAP_S) cue.for = Math.max(snapStep(), C.snapTo(beatsAt(s) - h.at, snapStep()));
    cues.push(cue);
    message('ok', el('strong', { text: `${C.KINDS[cue.kind].name}` }), ` at ${C.whereText(cue.at)} for ${C.beatsText(cue.for)} beat${cue.for === 1 ? '' : 's'}.`);
    rebuild();
  }
  function flashKey(key, on) {
    const k = document.querySelector(`#cqKeys [data-key="${key}"]`);
    if (k) k.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- sound and the clock
  function stopSound() {
    if (!src) return;
    pos = songNow();
    try { src.stop(); } catch {}
    src.disconnect();
    src = null;
  }
  function go(how) {
    if (!song) return;
    stop();
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') actx.resume();
      const from = Math.max(0, start - leadBeats() * beatS());
      src = actx.createBufferSource();
      src.buffer = song.buffer;
      src.connect(actx.destination);
      src.onended = () => { if (src && mode !== 'stop') stop(); };
      src.start(0, from);
      srcAt = actx.currentTime; srcFrom = from;
      mode = how;
    } catch (e) { message('bad', `Can't play the song here: ${e.message}`); return; }
    buttons();
    message('', how === 'record'
      ? 'Recording: press the keys as the song plays, and hold a key for as long as the cue should last. Press Stop (or Esc) when you\'re done.'
      : 'Playing back the cues with the song.');
  }
  function stop() {
    for (const k of [...held.keys()]) keyUp(k);
    stopSound();
    mode = 'stop';
    buttons();
  }
  function buttons() {
    $('cqRecord').textContent = mode === 'record' ? 'Stop' : 'Record cues';
    $('cqPlay').textContent = mode === 'play' ? 'Stop' : 'Play back';
    $('cqRecord').classList.toggle('rec', mode === 'record');
    $('cqPlay').disabled = !cues.length && mode !== 'play';
  }

  // ---------------------------------------------------------------- what's on screen
  function status() {
    $('cqBody').hidden = tab.family() !== 'pulse';
    $('cqCoreNote').hidden = tab.family() === 'pulse';
    $('cqNoSong').hidden = !!song;
    $('cqSong').textContent = song ? `${song.name}, ${song.grid.bpm} BPM` : '–';
    $('cqStart').textContent = song ? `${fmt(start)} (${M.barBeat(song.grid, start)})` : '–';
    $('cqUsePlay').disabled = !song || song.playAt == null || Math.abs(song.playAt - start) < 1e-3;
    $('cqRecord').disabled = !song;
    buttons();
    let info = '';
    if (buildError) info = buildError;
    else if (built) {
      const fits = built.bytes <= C.DEMO_ROOM;
      info = `${cues.length} cue${cues.length === 1 ? '' : 's'} over ${totalBeats()} beats (${(totalBeats() * beatS()).toFixed(1)} s), ${built.bytes} bytes. `
        + (fits ? `Fits on the 2.1 demo engine: 3 animations this size next to Poison's moment (room for about ${C.DEMO_ROOM} each).`
          : `Too big for 3 like it on the 2.1 demo engine next to Poison's moment (room for about ${C.DEMO_ROOM} each): use fewer cues or fewer colours.`);
    } else if (song) info = 'No cues yet. Press Record cues and play along.';
    $('cqInfo').textContent = info;
    $('cqInfo').classList.toggle('warn', !!buildError || (built && built.bytes > C.DEMO_ROOM));
  }

  function list() {
    const body = $('cqList');
    if (!cues.length) { body.replaceChildren(); return; }
    const order = cues.map((c, i) => i).sort((a, b) => cues[a].at - cues[b].at);
    const head = el('tr', {}, ...['Starts', 'Cue', 'Beats', 'LEDs', 'Colour', 'Brightness', ''].map((h) => el('th', { text: h })));
    const out = [head];
    for (const i of order) {
      const c = cues[i], k = C.KINDS[c.kind];
      const at = el('input', { type: 'number', min: '0', step: String(C.STEP), value: String(c.at), 'aria-label': 'Starts, beats from the start' });
      at.addEventListener('change', () => { c.at = Math.max(0, C.snapTo(Number(at.value) || 0, C.STEP)); rebuild(); });
      const kind = el('select', { 'aria-label': 'Cue' }, ...Object.entries(C.KINDS).map(([v, x]) => el('option', { value: v, text: `${x.name} (${x.key})` })));
      kind.value = c.kind;
      kind.addEventListener('change', () => { c.kind = kind.value; rebuild(); });
      const len = el('input', { type: 'number', min: String(C.STEP), step: String(C.STEP), value: String(c.for), 'aria-label': 'Length in beats' });
      len.addEventListener('change', () => { c.for = Math.max(C.STEP, C.snapTo(Number(len.value) || C.STEP, C.STEP)); rebuild(); });
      const zone = el('select', { 'aria-label': 'LEDs' }, ...C.ZONES.map((z) => el('option', { value: z, text: C.ZONE_NAMES[z] })));
      zone.value = c.zone;
      zone.addEventListener('change', () => { c.zone = zone.value; rebuild(); });
      const col = el('input', { type: 'color', value: C.hex(c.colour), 'aria-label': 'Colour' });
      col.disabled = !k.colour;
      col.title = k.colour ? '' : `${k.name} has no colour of its own: it ${k.says}.`;
      col.addEventListener('input', () => { c.colour = C.rgbOf(col.value); rebuild(); });
      const lv = el('input', { type: 'range', min: '0', max: '100', value: String(c.level), 'aria-label': 'Brightness' });
      lv.disabled = c.kind === 'cut';
      const lvText = el('span', { class: 'cq-pct', text: `${c.level}%` });
      lv.addEventListener('input', () => { lvText.textContent = `${lv.value}%`; });
      lv.addEventListener('change', () => { c.level = Number(lv.value); rebuild(); });
      const del = el('button', { class: 'btn quiet', type: 'button', text: 'Delete', 'aria-label': `Delete the ${k.name.toLowerCase()} at ${C.whereText(c.at)}` });
      del.addEventListener('click', () => { cues.splice(i, 1); rebuild(); });
      out.push(el('tr', {},
        el('td', {}, at, el('span', { class: 'cq-where', text: C.whereText(c.at) })),
        el('td', {}, kind), el('td', {}, len), el('td', {}, zone), el('td', {}, col),
        el('td', {}, lv, lvText), el('td', {}, del)));
    }
    body.replaceChildren(...out);
  }

  function drawStrip() {
    const cv = $('cqStrip');
    if (!show || !cv.clientWidth || $('cqBody').hidden) {
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      $('cqHead').hidden = true;
      return;
    }
    const span = totalBeats() * beatS() * 1000;
    tab.stripOn(cv, span, (ms) => frameAt(show, ms / 1000 / beatS()), rows);
  }
  function draw() {
    if (!song || $('cqBody').hidden) { tab.light(lens, DARK()); $('cqClock').textContent = ''; $('cqHead').hidden = true; return; }
    const s = songNow(), b = beatsAt(s);
    const sh = mode === 'record' ? liveShow() : show;
    tab.light(lens, b <= totalBeats() || held.size ? frameAt(sh, b) : DARK());
    const toGo = Math.ceil(-b - 1e-9);
    const where = b < 0 ? `lead-in, ${toGo} beat${toGo === 1 ? '' : 's'} to go` : C.whereText(Math.floor(b * 4) / 4);
    $('cqClock').textContent = `${fmt(s)} · ${where}`;
    $('cqHead').hidden = !show || b < 0 || b > totalBeats();
    if (show) $('cqHead').style.left = `${Math.max(0, Math.min(100, (b / totalBeats()) * 100))}%`;
  }

  let frames = 0;
  function tick() {
    const visible = !$('p-routines').hidden;
    // a song opened (or its beats changed) in Song moments: about twice a second
    if (visible && mode === 'stop' && tab.family() === 'pulse' && ++frames % 30 === 0) pickSong();
    if (!visible && mode !== 'stop') stop();
    if (visible && src) {
      const b = beatsAt(songNow());
      if (mode === 'play' && b > totalBeats() + 4) stop();
      draw();
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- keys
  const typing = (t) => t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(range|color|checkbox|radio|button)$/.test(t.type)));
  document.addEventListener('keydown', (e) => {
    if ($('p-routines').hidden || $('cqBody').hidden || !song || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (key === 'Escape' && mode !== 'stop') { stop(); e.preventDefault(); return; }
    if (/^[1-4]$/.test(key)) { $('cqZone').value = C.ZONES[Number(key) - 1]; e.preventDefault(); return; }
    if (mode !== 'record') return;
    if (C.KIND_BY_KEY[key]) { e.preventDefault(); if (!e.repeat) keyDown(key); }
    else if (key === 'Z' || key === 'Backspace') { e.preventDefault(); undo(); }
  });
  document.addEventListener('keyup', (e) => {
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (held.has(key)) keyUp(key);
  });
  window.addEventListener('blur', () => { for (const k of [...held.keys()]) keyUp(k); });
  function undo() {
    if (!cues.length) return;
    const c = cues.pop();
    message('', `Took out the ${C.KINDS[c.kind].name.toLowerCase()} at ${C.whereText(c.at)}.`);
    rebuild();
  }

  // ---------------------------------------------------------------- controls
  $('cqKeys').replaceChildren(...Object.values(C.KINDS).map((k) =>
    el('span', { class: 'cq-key', 'data-key': k.key, title: `${k.name}: ${k.says}` }, el('kbd', { text: k.key }), ` ${k.name}`)));
  $('cqRecord').addEventListener('click', () => (mode === 'record' ? stop() : go('record')));
  $('cqPlay').addEventListener('click', () => (mode === 'play' ? stop() : go('play')));
  $('cqUndo').addEventListener('click', undo);
  $('cqClear').addEventListener('click', () => {
    if (!cues.length) return;
    if (!confirm(`Delete all ${cues.length} cues?`)) return;
    cues = [];
    message('', 'All cues deleted.');
    rebuild();
  });
  $('cqUsePlay').addEventListener('click', () => { if (song && song.playAt != null) { start = song.playAt; pos = start; rebuild(); } });
  $('cqEarlier').addEventListener('click', () => { if (song) { start = Math.max(0, start - beatS()); rebuild(); } });
  $('cqLater').addEventListener('click', () => { if (song) { start = Math.min(song.duration, start + beatS()); rebuild(); } });
  $('cqLevel').addEventListener('input', () => { $('cqLevelText').textContent = `${$('cqLevel').value}%`; });
  $('cqUnderLevel').addEventListener('input', () => { $('cqUnderText').textContent = `${$('cqUnderLevel').value}%`; });
  for (const id of ['cqUnder', 'cqUnderLevel']) $(id).addEventListener('change', rebuild);
  $('cqName').addEventListener('change', rebuild);
  function recipe() { return built && built.recipe; }
  $('cqCopy').addEventListener('click', async () => {
    if (!recipe()) return;
    try { await navigator.clipboard.writeText(recipeText(recipe())); saveMsg('Copied the recipe. Paste it into the Animation lab, or into a Claude Code session to change it.'); }
    catch { saveMsg('Couldn\'t copy here. Use Open in the Animation lab instead.'); }
  });
  $('cqToLab').addEventListener('click', () => {
    if (!recipe()) return;
    stop();
    $('labText').value = recipeText(recipe());
    $('labText').dispatchEvent(new Event('input'));
    $('labTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('cqSave').addEventListener('click', async () => {
    if (!recipe()) return saveMsg('Record some cues first.');
    if (!state.library) return saveMsg('Choose a library folder first (Library tab, Choose library folder). Animations are kept in its animations folder.');
    try {
      const { animation, file, replaced } = await state.library.saveAnimation(recipe(), $('cqName').value);
      $('cqName').value = animation.name;
      rebuild();
      tab.lab.reload();
      await tab.moments.useAnimation(animation.name);
      saveMsg(`Saved "${animation.name}" as animations/${file}${replaced ? ', replacing the one saved before' : ''}${state.library.saved ? '' : ' (demo library: lost when you close the page)'}. It's now the animation in Song moments above: press Play there to see it where the drive recognises the song, then Save song moment.`);
    } catch (e) { saveMsg(e.message); }
  });

  // For the headless checks: add cues without a keyboard, and stop the clock at a song time.
  window.synaptoCues = {
    add(list) { cues.push(...C.cleanCues(list)); rebuild(); },
    at(s) { stop(); pos = s; draw(); },
    cues: () => cues.map((c) => ({ ...c })),
    recipe: () => recipe(),
    press: keyDown, release: keyUp, record: () => go('record'), stop,
  };

  requestAnimationFrame(tick);
  function reload() {
    tab.buildBoard($('cqBoard'), lens);
    rows = drawnLeds(tab.profile()).map((q) => q.led - 1).reverse();
    if (tab.family() !== 'pulse') { stop(); status(); return; }
    pickSong();
    rebuild();
  }
  return { reload, refresh: () => { if (song && mode === 'stop') rebuild(); }, redraw: () => { drawStrip(); draw(); } };
}
