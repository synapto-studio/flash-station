// Light cues in the Routines tab (R8, R9), Pulse only. Uses the song open in Song moments: press
// Record cues, the song plays from a little before Play at, and each key press (W white pulse,
// B brightness pulse, S shimmer, T stutter, X cut out, F fade up, D fade down, K on every kick,
// N on every snare; held for as long as the cue should last) adds a cue, snapped to the beat
// grid. The song runs through the simulated mic in the Song moments room, as the drive hears it,
// so the timeline shows the normal look, the cues and what the drive will show (the cues over
// the normal look, or over dark or a colour), with the kicks and snares the drive hears; taps
// that line up with them can be folded into one "on every snare" cue. Each cue's LEDs (top,
// middle, bottom or all), colour and brightness can be changed in the list, then the cues are
// saved as an animation (animations/) and picked for the song moment. The maths is js/cues.js.

import { Show, makeDrive, length, toPixels } from './player.js';
import { recipeText } from './lab.js';
import { drawnLeds } from './profiles.js';
import { pulseAmbient, pulseMusic } from './animations.js';
import * as pulse from './preview-pulse.js';
import * as C from './cues.js';
import * as M from './moments.js';

const TAP_S = 0.3;            // held shorter than this, a key press is a tap (the cue's tap length)
const STORE = 'synapto-cues:'; // + the song's name: that song's cues, kept in this browser
const PREROLL = 1;            // s of room before the music the drive hears (it's plugged in at 0)
const LEAD = 12;              // s of music it hears before the lead-in, so it has found the beat
const BEAT = 16384;           // one beat in the player's beat clock
const MIN_VIEW = 16;          // beats: the timeline shows at least 4 bars
const fmt = M.fmtTime;

export function initLightCues({ $, el, state, tab }) {
  // tab: { family(), settings(f), profile(), buildBoard(box, lensEls), stripOn(cv, len, frameFn, rows), light(lensEls, px), moments, lab }
  let song = null;            // moments.current(): { name, buffer, audio, rate, duration, grid, playAt, room }
  let start = 0;              // s in the song where the animation starts (on a beat)
  let cues = [];
  let built = null, show = null, alone = null, buildError = null; // C.build()'s result, the drive's show, the cues alone
  let heard = { key: null };  // the song as the drive hears it around the cues (hear())
  let offers = [];            // taps that could be one "on every kick/snare" cue (C.foldOffers)
  let look = null;            // a Show whose normal look (underLevels) is the drive's ambient, as heard
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
  const under = () => ({ mode: $('cqUnderMode').value, colour: C.rgbOf($('cqUnder').value), level: level('cqUnderLevel'),
    colours: newColours() });
  // The normal look's colours picked for under the cues: only those changed from the routine's own.
  function newColours() {
    const S = tab.settings('pulse'), own = { 1: S.red, 2: S.orange }, out = {};
    for (const k of Object.keys(C.LOOK_COLOURS)) { const c = C.rgbOf($(`cqRe${k}`).value); if (C.hex(c) !== C.hex(own[k])) out[k] = c; }
    return out;
  }
  function underFields() {
    const m = $('cqUnderMode').value;
    $('cqUnderColour').hidden = m !== 'colour';
    $('cqUnderNew').hidden = m !== 'recolour';
  }

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
    const u = C.cleanUnder(saved && saved.under), S = tab.settings('pulse');
    $('cqUnderMode').value = saved ? u.mode : 'normal';
    if (u.colour) { $('cqUnder').value = C.hex(u.colour); $('cqUnderLevel').value = String(u.level); }
    $('cqUnderText').textContent = `${$('cqUnderLevel').value}%`;
    // new colours start as the routine's own, so the look only changes where a colour is picked
    $('cqRe1').value = C.hex((u.colours && u.colours[1]) || S.red);
    $('cqRe2').value = C.hex((u.colours && u.colours[2]) || S.orange);
    underFields();
  }
  const playAtOrStart = () => (song.playAt != null ? song.playAt : M.snapUp(song.grid, Math.max(0, song.grid.firstBar)));

  // ---------------------------------------------------------------- the song from Song moments
  function pickSong() {
    const now = tab.moments.current();
    const same = song && now && now.name === song.name && now.grid.bpm === song.grid.bpm && now.grid.firstBar === song.grid.firstBar;
    if (same) {
      if (song.playAt !== now.playAt) { song.playAt = now.playAt; status(); }
      if (song.room !== now.room) { song.room = now.room; song.roomName = now.roomName; rebuild(); }
      return;
    }
    stop();
    song = now;
    if (song) restore();
    else cues = [];
    $('cqName').value = song ? `${song.name.replace(/\.[^.]+$/, '')} cues` : '';
    rebuild();
  }

  // ---------------------------------------------------------------- the song as the drive hears it
  // From LEAD s before the lead-in to past the end of the timeline, through the simulated mic in the
  // room picked in Song moments: the drive's own beat clock, kicks and snares (preview-pulse.js),
  // and when its ambient (the normal look) started. Times on screen are song seconds.
  function hear() {
    const toS = start + viewBeats() * beatS() + 2;
    const key = [song.name, song.duration, song.grid.bpm, song.grid.firstBar, start, leadBeats(), song.room, Math.ceil(toS / 10)].join('|');
    if (heard.key === key) return heard;
    const segFrom = Math.max(0, start - leadBeats() * beatS() - LEAD), to = Math.min(song.duration, Math.ceil(toS / 10) * 10 + 2);
    const seg = song.audio.subarray(Math.floor(segFrom * song.rate), Math.floor(to * song.rate));
    const S = tab.settings('pulse');
    const st = pulse.stage1(pulse.micVolts(seg, song.rate, song.room || 'club', PREROLL, 7), song.rate);
    const run = pulse.stage2(st, S), base = pulseMusic(run, st);
    const shift = (start - segFrom + PREROLL) * 1000 - run.startMs;     // show ms 0 = the cues' start
    const hits = { kick: [], snare: [] };
    for (let i = 0; i < st.n; i++) {
      const b = (segFrom + st.now[i] / 1000 - PREROLL - start) / beatS();
      if (run.kOn[i]) hits.kick.push(b);
      if (run.sOn[i]) hits.snare.push(b);
    }
    heard = { key, music: (ms) => base(ms + shift), underFrom: run.phaseEnds[6] - shift, hits, until: (to - start) * 1000 };
    return heard;
  }

  // ---------------------------------------------------------------- the animation
  const showOf = (anim, h, withLook) => new Show({ sections: [anim], under: withLook ? pulseAmbient(tab.settings('pulse')) : null, underFrom: h.underFrom,
    drive: makeDrive(tab.profile()), colours: tab.settings('pulse'), brightness: tab.settings('pulse').brightness, music: h.music });
  function rebuild() {
    built = null; show = null; alone = null; look = null; buildError = null; offers = [];
    if (song) {
      let h = null;
      try { h = hear(); } catch (e) { buildError = `Couldn't hear the song through the simulated mic: ${e.message}`; }
      if (h) {
        look = showOf(pulseAmbient(tab.settings('pulse')), h, true);
        if (cues.length) {
          try {
            built = C.build({ name: $('cqName').value.trim() || 'Light cues', cues, under: under(), drive: makeDrive(tab.profile()) });
            show = showOf(built.anim, h, true);
            alone = showOf(built.anim, h, false);
          } catch (e) { buildError = e.message; }
          offers = C.foldOffers(cues, h.hits);
        }
      }
    }
    status(); list(); foldBox(); drawStrip(); draw();
    for (const id of ['cqSave', 'cqToLab', 'cqCopy']) $(id).disabled = !built;
    keep();
  }
  // The animation as it plays with the key still down: held cues grow to now.
  function liveShows() {
    if (!held.size || !song) return { show, alone };
    const b = beatsAt(songNow());
    const extra = [...held.values()].map((h) => ({ ...newCue(h.kind, h.at), for: Math.max(C.STEP, b - h.at) }));
    try {
      const all = [...cues, ...extra].slice(-C.maxCues(under()));
      const r = C.build({ cues: all, under: under(), drive: makeDrive(tab.profile()) });
      return { show: showOf(r.anim, heard, true), alone: showOf(r.anim, heard, false) };
    } catch { return { show, alone }; }
  }
  const totalBeats = () => C.cuesLength(cues);
  const viewBeats = () => Math.max(MIN_VIEW, Math.ceil(totalBeats() / 4) * 4);
  const DARK = () => Array.from({ length: 8 }, () => [0, 0, 0]);
  const brightness = () => tab.settings('pulse').brightness;
  // At ms after the cues' start (on the song's clock): the normal look; the cues alone (dark around
  // them); what the drive shows: the normal look, and the moment while it plays.
  function lookAt(ms) {
    if (!look) return DARK();
    try { return toPixels(look.underLevels(ms), brightness()); } catch { return DARK(); }
  }
  function playing(sh, ms) {
    if (!sh || ms < 0) return false;
    const a = sh.sections[0];
    return sh.music(ms).beats - sh.music(0).beats < length(a) * BEAT;
  }
  function cuesAt(sh, ms) {
    if (!playing(sh, ms)) return DARK();
    try { return sh.frame(Math.round(ms)); } catch { return DARK(); }
  }
  function driveAt(sh, ms) {
    if (!playing(sh, ms)) return lookAt(ms);
    try { return sh.frame(Math.round(ms)); } catch { return lookAt(ms); }
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
    const most = C.maxCues(under());
    if (cues.length + held.size >= most) return message('bad', el('strong', { text: `That's ${most} cues, the most one animation can have. ` }), 'Delete or undo some, or save these and start another.');
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
        + (fits ? `Fits on the 2.2 demo engine next to Poison's moment (room for one more moment, about ${C.DEMO_ROOM} bytes).`
          : `Too big for the 2.2 demo engine next to Poison's moment (room for one more moment, about ${C.DEMO_ROOM} bytes): use fewer cues or fewer colours.`);
    } else if (song) info = 'No cues yet. Press Record cues and play along.';
    $('cqInfo').textContent = info;
    $('cqInfo').classList.toggle('warn', !!buildError || (built && built.bytes > C.DEMO_ROOM));
    const h = heard.hits;
    $('cqHeard').textContent = song && h
      ? `The song as the drive hears it in the simulated ${song.roomName || 'club'} (the room picked in Song moments): ${h.kick.filter((b) => b >= 0 && b < viewBeats()).length} kicks and ${h.snare.filter((b) => b >= 0 && b < viewBeats()).length} snares in these ${viewBeats() / 4} bars. The drive plays the cues on its own beat clock, so they can land a little off the song's grid.`
      : '';
  }

  // Taps that line up with the kicks or snares the drive hears: offer to make them one cue.
  function foldBox() {
    const box = $('cqFold');
    box.hidden = !offers.length;
    box.replaceChildren(...offers.map((o) => {
      const go = el('button', { class: 'btn', type: 'button', text: 'Make it one cue' });
      go.addEventListener('click', () => {
        cues = C.fold(cues, o);
        message('ok', el('strong', { text: 'Done. ' }), `${o.indexes.length} cues are now one: ${C.KINDS[o.cue.kind].name.toLowerCase()} from ${C.whereText(o.cue.at)} for ${C.beatsText(o.cue.for)} beats.`);
        rebuild();
      });
      return el('div', { class: 'cq-offer' }, el('span', { text: `${o.text}. One cue instead of ${o.indexes.length}, and it follows the drive's own ears.` }), go);
    }));
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
      const kind = el('select', { 'aria-label': 'Cue' }, ...Object.entries(C.KINDS).map(([v, x]) => el('option', { value: v, text: x.key ? `${x.name} (${x.key})` : x.name })));
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
      lv.disabled = c.kind === 'cut' || !!k.hits;
      if (k.hits) lv.title = `As bright as the drive hears each ${k.hits}: a harder hit flashes brighter.`;
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

  const STRIPS = [['cqStripLook', lookAt], ['cqStrip', (ms) => cuesAt(alone, ms)], ['cqStripDrive', (ms) => driveAt(show, ms)]];
  function drawStrip() {
    const off = !song || !look || $('cqBody').hidden;
    $('cqTimeline').hidden = off;
    if (off || !$('cqStrip').clientWidth) { $('cqHead').hidden = true; return; }
    const span = viewBeats() * beatS() * 1000;
    for (const [id, fn] of STRIPS) tab.stripOn($(id), span, fn, rows);
    drawHits();
  }
  // Bars, and the kicks (upper row) and snares (lower row) the drive hears.
  function drawHits() {
    const cv = $('cqHits'), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)), hgt = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = hgt;
    const g = cv.getContext('2d'), n = viewBeats(), X = (b) => Math.round((b / n) * w);
    const css = getComputedStyle(document.documentElement);
    const paper = css.getPropertyValue('--paper').trim() || '#f1eae3', muted = css.getPropertyValue('--muted').trim() || '#b5a99f', resin = css.getPropertyValue('--resin').trim() || '#ff8a2a';
    g.font = `${11 * dpr}px Barlow, system-ui, sans-serif`; g.textBaseline = 'top';
    for (let bar = 0; bar < n / 4; bar++) {
      g.fillStyle = 'rgba(241,234,227,0.25)'; g.fillRect(X(bar * 4), 0, dpr, hgt);
      if (X(4) > 22 * dpr || bar % 2 === 0) { g.fillStyle = muted; g.fillText(String(bar + 1), X(bar * 4) + 3 * dpr, 1 * dpr); }
    }
    const half = hgt / 2, mark = (b, top, colour) => { if (b < 0 || b > n) return; g.fillStyle = colour; g.fillRect(X(b) - dpr, top + 3 * dpr, 2 * dpr, half - 6 * dpr); };
    for (const b of heard.hits ? heard.hits.kick : []) mark(b, 0, paper);
    for (const b of heard.hits ? heard.hits.snare : []) mark(b, half, resin);
  }
  function draw() {
    if (!song || $('cqBody').hidden) { tab.light(lens, DARK()); $('cqClock').textContent = ''; $('cqHead').hidden = true; return; }
    const s = songNow(), b = beatsAt(s), ms = (s - start) * 1000;
    const sh = mode === 'record' ? liveShows().show : show;
    tab.light(lens, driveAt(sh, ms));
    const toGo = Math.ceil(-b - 1e-9);
    const where = b < 0 ? `lead-in, ${toGo} beat${toGo === 1 ? '' : 's'} to go` : C.whereText(Math.floor(b * 4) / 4);
    $('cqClock').textContent = `${fmt(s)} · ${where}`;
    $('cqHead').hidden = !look || b < 0 || b > viewBeats();
    $('cqHead').style.left = `${Math.max(0, Math.min(100, (b / viewBeats()) * 100))}%`;
  }

  let frames = 0;
  function tick() {
    const visible = !$('p-routines').hidden;
    // a song opened (or its beats changed) in Song moments: about twice a second
    if (visible && mode === 'stop' && tab.family() === 'pulse' && ++frames % 30 === 0) pickSong();
    if (!visible && mode !== 'stop') stop();
    if (visible && src) {
      const b = beatsAt(songNow());
      if (mode === 'play' && b > Math.max(totalBeats() + 4, viewBeats())) stop();
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
  $('cqKeys').replaceChildren(...Object.values(C.KINDS).filter((k) => k.key).map((k) =>
    el('span', { class: 'cq-key', 'data-key': k.key, title: `${k.name}: ${k.says}` }, el('kbd', { text: k.key }), ` ${k.name}`)));
  $('cqRecord').addEventListener('click', () => { if (mode === 'record') return stop(); pickSong(); go('record'); });
  $('cqPlay').addEventListener('click', () => { if (mode === 'play') return stop(); pickSong(); go('play'); });
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
  for (const id of ['cqUnder', 'cqUnderLevel', 'cqRe1', 'cqRe2']) $(id).addEventListener('change', rebuild);
  $('cqUnderMode').addEventListener('change', () => { underFields(); rebuild(); });
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
    hits: () => heard.hits,
    offers: () => offers.map((o) => o.text),
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
  underFields();
  return { reload, refresh: () => { if (song && mode === 'stop') rebuild(); }, redraw: () => { drawStrip(); draw(); } };
}
