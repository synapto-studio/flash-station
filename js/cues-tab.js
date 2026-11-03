// Light cues in the Routines tab (R8, R9, R10), Pulse only: a timeline editor over the song open in
// Song moments. Each row is a layer with one effect (js/cues.js KINDS: white pulse, shimmer, cut
// out, fades, on every kick or snare, Recolour...), placed at one or more times over a bar ruler;
// rows higher up draw over lower ones. Under the rows: the drive's normal look, the kicks and
// snares the drive hears, and what the drive will show (the song runs through the simulated mic in
// the Song moments room). Effects are dragged along their row (snapped to the grid), lengthened
// from either end, and copied with Alt-drag; copies are linked (one look). Record plays the song and
// each key (W, B, S, T, X, F, D, K, N, R; held for as long as the effect should last) adds its
// effect, into the chosen layer or a layer of its own. Undo, mute, rename, reorder, zoom by bars,
// click the ruler for the playhead. Saved per song in the browser and as an animation (its tracks
// go in the file, so it opens again as tracks). The maths is js/cues.js.

import { Show, makeDrive, toPixels, length } from './player.js';
import { recipeText } from './lab.js';
import { drawnLeds } from './profiles.js';
import { pulseAmbient, pulseMusic } from './animations.js';
import * as pulse from './preview-pulse.js';
import * as C from './cues.js';
import * as M from './moments.js';

const TAP_S = 0.3;            // held shorter than this, a key press is a tap (the effect's tap length)
const STORE = 'synapto-cues:'; // + the song's name: that song's timeline, kept in this browser
const PREROLL = 1;            // s of room before the music the drive hears (it's plugged in at 0)
const LEAD = 12;              // s of music it hears before the lead-in, so it has found the beat
const BEAT = 16384;           // one beat in the player's beat clock
const MIN_VIEW = 16;          // beats: the timeline is at least 4 bars
const ZOOMS = [2, 4, 8, 16, 32, 64];   // bars across the screen
const UNDO_MOST = 80;
const MAX_STRIP_PX = 6000;    // a strip's canvas at most this wide (the rest is stretched)
const fmt = M.fmtTime;
const SPANS = [[0, 'At once'], [0.0625, '1/16 beat'], [0.125, '1/8 beat'], [0.25, '1/4 beat'], [0.5, '1/2 beat'], [1, '1 beat'], [2, '2 beats'], [4, '1 bar']];
const EVERY = [[0.5, 'half a beat'], [1, 'beat'], [2, '2 beats'], [4, 'bar'], [8, '2 bars'], [16, '4 bars']];

export function initLightCues({ $, el, state, tab }) {
  // tab: { family(), settings(f), profile(), buildBoard(box, lensEls), stripOn(cv, len, frameFn, rows), light(lensEls, px), moments, lab }
  let song = null;            // moments.current(): { name, buffer, audio, rate, duration, grid, playAt, room }
  let start = 0;              // s in the song where the animation starts (on a beat)
  let tracks = C.emptyTracks();
  let built = null, show = null, buildError = null;   // C.buildTracks()'s result, the drive's show
  let costs = {};             // each row's id -> the layers of animation it makes (C.rowLayers)
  let heard = { key: null };  // the song as the drive hears it around the timeline (hear())
  let offers = [], offerCues = [];   // taps that could be one "on every kick/snare" effect
  let look = null;            // a Show whose normal look (underLevels) is the drive's ambient, as heard
  let mode = 'stop';          // 'stop' | 'record' | 'play'
  let actx = null, src = null, srcAt = 0, srcFrom = 0, playFrom = 0;
  let pos = 0;                // s in the song: the playhead while stopped
  const held = new Map();     // key -> { kind, at (beats), t0 (song s), row (id or null) }
  let recRows = {};           // this recording: kind -> the row id its key made
  let sel = null;             // the selected copy: { row, group, i }
  let chosen = null;          // the chosen layer's id: Record records into it
  let zoom = 2;               // ZOOMS[zoom] bars across
  let undoList = [];
  const lens = [];
  let ledRows = [];

  const beatS = () => 60 / song.grid.bpm;
  const beatsAt = (s) => (s - start) / beatS();
  const songAt = (b) => start + b * beatS();
  const songNow = () => (src ? srcFrom + (actx.currentTime - srcAt) : pos);
  const snapStep = () => Number($('cqSnap').value) || 0.25;
  const leadBeats = () => Number($('cqLead').value) || 0;
  const level = (id) => Math.max(0, Math.min(100, Number($(id).value) || 0));
  const rowIndex = (id) => tracks.rows.findIndex((r) => r.id === id);
  const drive = () => makeDrive(tab.profile());

  // ---------------------------------------------------------------- messages
  function message(kind, ...parts) { const b = $('cqMsg'); b.className = `lab-msg ${kind}`; b.replaceChildren(...parts); }
  const saveMsg = (text) => { $('cqSaveMsg').textContent = text; };

  // ---------------------------------------------------------------- changes, undo, kept in the browser
  function change(fn) {
    undoList.push(JSON.stringify(tracks));
    if (undoList.length > UNDO_MOST) undoList.shift();
    fn();
    rebuild();
  }
  function undo() {
    if (!undoList.length) return;
    tracks = JSON.parse(undoList.pop());
    sel = null;
    message('', 'Undone.');
    rebuild();
  }
  function keep() {
    if (!song) return;
    try { localStorage.setItem(STORE + song.name, JSON.stringify({ start, tracks })); } catch {}
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE + song.name) || 'null'); } catch {}
    // R8, R9 kept a list of cues and what was under them: they open as tracks
    tracks = (saved && C.cleanTracks(saved.tracks)) || (saved && saved.cues ? C.cuesToTracks(C.cleanCues(saved.cues), saved.under) : C.emptyTracks());
    start = saved && Number.isFinite(saved.start) ? saved.start : playAtOrStart();
    pos = start; sel = null; chosen = null; undoList = [];
    underToControls();
  }
  const playAtOrStart = () => (song.playAt != null ? song.playAt : M.snapUp(song.grid, Math.max(0, song.grid.firstBar)));

  // What's under the effects: the controls and tracks.under
  function underToControls() {
    const u = tracks.under || { mode: 'normal' };
    $('cqUnderMode').value = C.underMode(u);
    if (u.colour) $('cqUnder').value = C.hex(u.colour);
    $('cqUnderLevel').value = String(Number.isFinite(u.level) ? u.level : 30);
    $('cqUnderText').textContent = `${$('cqUnderLevel').value}%`;
    $('cqUnderColour').hidden = $('cqUnderMode').value !== 'colour';
  }
  const controlsUnder = () => ({ mode: $('cqUnderMode').value, colour: C.rgbOf($('cqUnder').value), level: level('cqUnderLevel') });

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
    else tracks = C.emptyTracks();
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
    const shift = (start - segFrom + PREROLL) * 1000 - run.startMs;     // show ms 0 = the timeline's start
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
  // (most: Infinity: a timeline still too big for a drive plays here too, so you can see it before trimming it)
  const showOf = (anim, h) => new Show({ sections: [anim], under: pulseAmbient(tab.settings('pulse')), underFrom: h.underFrom,
    drive: drive(), colours: tab.settings('pulse'), brightness: tab.settings('pulse').brightness, music: h.music, most: Infinity });
  const hasClips = () => tracks.rows.some((r) => r.groups.length);
  function rebuild() {
    built = null; show = null; look = null; buildError = null; offers = []; costs = {};
    tracks.under = controlsUnder();
    if (song) {
      let h = null;
      try { h = hear(); } catch (e) { buildError = `Couldn't hear the song through the simulated mic: ${e.message}`; }
      if (h) {
        look = showOf(pulseAmbient(tab.settings('pulse')), h);
        if (hasClips()) {
          try {
            built = C.buildTracks({ name: $('cqName').value.trim() || 'Light cues', tracks, drive: drive() });
            show = showOf(built.anim, h);
            buildError = C.tooManyText(built);
          } catch (e) { buildError = e.message; }
          costs = C.rowLayers(tracks, drive());
          offerCues = C.tracksCues(tracks);
          offers = C.foldOffers(offerCues, h.hits);
        }
      }
    }
    if (sel && !clipAt(sel)) sel = null;
    if (chosen && rowIndex(chosen) < 0) chosen = null;
    status(); renderSheet(); inspector(); foldBox(); drawStrips(); draw();
    for (const id of ['cqSave', 'cqToLab', 'cqCopy']) $(id).disabled = !built || built.tooMany;
    $('cqUndo').disabled = !undoList.length;
    keep();
  }
  // The animation as it plays while keys are held: their effects grow to now.
  function liveShow() {
    if (!held.size || !song) return show;
    const b = beatsAt(songNow()), t = JSON.parse(JSON.stringify(tracks));
    for (const h of held.values()) {
      const ri = h.row ? t.rows.findIndex((r) => r.id === h.row) : -1;
      const at = ri >= 0 ? ri : t.rows.push(C.newRow(t, h.kind)) - 1;
      C.place(t, at, h.at, lookFor(t.rows[at], h.kind, Math.max(C.STEP, b - h.at)));
    }
    try { return showOf(C.buildTracks({ tracks: t, drive: drive(), squeeze: false }).anim, heard); } catch { return show; }
  }
  // An effect placed on a row: the look of its last one there (so a layer keeps its settings), or a
  // new look from the "New effects" controls
  function lookFor(row, kind, len) {
    const last = row && row.groups[row.groups.length - 1];
    if (last) return { ...JSON.parse(JSON.stringify(last.look)), ...(len ? { for: len } : {}) };
    const z = $('cqZone').value, k = row ? row.kind : kind;
    return C.defaultLook(k, { zones: z === 'all' ? C.PARTS : [z], ...(C.KINDS[k].white ? {} : { colour: C.rgbOf($('cqColour').value) }), level: level('cqLevel'), ...(len ? { for: len } : {}) });
  }
  const contentBeats = () => C.clips(tracks).reduce((m, c) => Math.max(m, c.at + c.for), 0);
  const viewBeats = () => Math.max(MIN_VIEW, Math.ceil((contentBeats() + 4) / 4) * 4);
  const DARK = () => Array.from({ length: 8 }, () => [0, 0, 0]);
  const brightness = () => tab.settings('pulse').brightness;
  // At ms after the timeline's start (on the song's clock): the normal look; what the drive shows:
  // the normal look, and the moment while it plays.
  function lookAt(ms) {
    if (!look) return DARK();
    try { return toPixels(look.underLevels(ms), brightness()); } catch { return DARK(); }
  }
  function driveAt(sh, ms) {
    if (!sh || ms < 0 || sh.music(ms).beats - sh.music(0).beats >= length(sh.sections[0]) * BEAT) return lookAt(ms);
    try { return sh.frame(Math.round(ms)); } catch { return lookAt(ms); }
  }

  // ---------------------------------------------------------------- recording
  function keyDown(key) {
    if (mode !== 'record' || held.has(key)) return;
    const kind = C.KIND_BY_KEY[key];
    const s = songNow(), at = C.snapTo(beatsAt(s), snapStep());
    if (at < 0) return message('', `That was in the lead-in, before the start (${fmt(start)}). Effects start from there.`);
    held.set(key, { kind, at, t0: s, row: chosen || recRows[kind] || null });
    flashKey(key, true);
  }
  function keyUp(key) {
    const h = held.get(key);
    if (!h) return;
    held.delete(key);
    flashKey(key, false);
    const s = songNow();
    const len = s - h.t0 >= TAP_S ? Math.max(snapStep(), C.snapTo(beatsAt(s) - h.at, snapStep())) : null;
    change(() => {
      let ri = h.row ? rowIndex(h.row) : -1;
      if (ri < 0) { tracks.rows.unshift(C.newRow(tracks, h.kind)); ri = 0; recRows[h.kind] = tracks.rows[0].id; }
      const r = tracks.rows[ri];
      const lk = lookFor(r, h.kind, len || (r.groups.length ? null : C.KINDS[r.kind].tap));
      if (!len && !r.groups.length) lk.for = C.KINDS[r.kind].tap;
      sel = C.place(tracks, ri, h.at, lk);
    });
    const r = tracks.rows[sel.row];
    message('ok', el('strong', { text: C.KINDS[r.kind].name }), ` at ${C.whereText(h.at)} on "${r.name}".`);
  }
  function flashKey(key, on) {
    const k = document.querySelector(`#cqKeys [data-key="${key}"]`);
    if (k) k.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- sound and the clock
  function stopSound() {
    if (!src) return;
    try { src.stop(); } catch {}
    src.disconnect();
    src = null;
  }
  // Play: from the playhead. Record: from the lead-in before it.
  function go(how) {
    if (!song) return;
    stop();
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') actx.resume();
      playFrom = pos;
      const from = Math.max(0, pos - (how === 'record' ? leadBeats() * beatS() : 0));
      src = actx.createBufferSource();
      src.buffer = song.buffer;
      src.connect(actx.destination);
      src.onended = () => { if (src && mode !== 'stop') stop(); };
      src.start(0, from);
      srcAt = actx.currentTime; srcFrom = from;
      mode = how;
      recRows = {};
    } catch (e) { message('bad', `Can't play the song here: ${e.message}`); return; }
    buttons();
    const into = chosen ? ` into "${tracks.rows[rowIndex(chosen)].name}"` : '';
    message('', how === 'record'
      ? `Recording${into}: press the keys as the song plays, and hold a key for as long as the effect should last. Press Stop (or Esc) when you're done.`
      : 'Playing from the playhead.');
  }
  function stop() {
    for (const k of [...held.keys()]) keyUp(k);
    stopSound();
    if (mode !== 'stop') pos = playFrom;   // the playhead goes back to where it started
    mode = 'stop';
    buttons();
    draw();
  }
  function buttons() {
    $('cqRecord').textContent = mode === 'record' ? 'Stop' : 'Record';
    $('cqPlay').textContent = mode === 'play' ? 'Stop' : 'Play';
    $('cqRecord').classList.toggle('rec', mode === 'record');
    $('cqPlay').disabled = !song;
    $('cqRecord').disabled = !song;
  }

  // ---------------------------------------------------------------- what's on screen
  function status() {
    $('cqBody').hidden = tab.family() !== 'pulse';
    $('cqCoreNote').hidden = tab.family() === 'pulse';
    $('cqNoSong').hidden = !!song;
    $('cqSong').textContent = song ? `${song.name}, ${song.grid.bpm} BPM` : '–';
    $('cqStart').textContent = song ? `${fmt(start)} (${M.barBeat(song.grid, start)})` : '–';
    $('cqUsePlay').disabled = !song || song.playAt == null || Math.abs(song.playAt - start) < 1e-3;
    buttons();
    const placed = C.clips(tracks).filter((c) => !tracks.rows[c.row].muted).length, n = tracks.rows.length;
    let info = '';
    if (built) {
      const len = C.tracksLength(tracks), by = built.bytes;
      const room = built.tooMany ? buildError
        : by <= C.DEMO_ROOM ? `Fits on the demo engine (2.3) next to Poison's moment (room for one more moment, about ${C.DEMO_ROOM} bytes).`
          : by <= C.DEMO_ALONE ? `Too big to go next to Poison's moment on the demo engine (2.3: about ${C.DEMO_ROOM} bytes), but it fits as the demo's only song moment (about ${C.DEMO_ALONE}).`
            : `Too big for the demo engine (2.3): about ${C.DEMO_ROOM} bytes next to Poison's moment, ${C.DEMO_ALONE} as its only moment. Mute or delete some effects, link copies, or use fewer colours.`;
      info = `${placed} effect${placed === 1 ? '' : 's'} on ${n} layer${n === 1 ? '' : 's'}, ${len} beats (${(len * beatS()).toFixed(1)} s): ${built.layers} layer${built.layers === 1 ? '' : 's'} of animation, ${by} bytes. ${room}`;
    } else if (buildError) info = buildError;
    else if (song) info = 'Nothing on the timeline yet. Press Record and play along, or add a layer and double-click on it.';
    $('cqInfo').textContent = info;
    $('cqInfo').classList.toggle('warn', !!buildError || (built && built.bytes > C.DEMO_ROOM));
    // the meter: layers of animation (15 at most) and bytes on the demo, after squeezing
    const lay = built ? built.layers : 0, by = built ? built.bytes : 0;
    $('cqLayersText').textContent = `${lay} of ${C.MAX_LAYERS}`;
    $('cqBytesText').textContent = `${by} of ${C.DEMO_ROOM}`;
    $('cqLayersBar').style.width = `${Math.min(100, (lay / C.MAX_LAYERS) * 100)}%`;
    $('cqBytesBar').style.width = `${Math.min(100, (by / C.DEMO_ROOM) * 100)}%`;
    $('cqBytesBar').classList.toggle('over', by > C.DEMO_ROOM);
    $('cqLayersBar').classList.toggle('over', !!(built && built.tooMany));
    const sq = built && (built.before.layers > built.layers || built.before.bytes > built.bytes);
    $('cqSqueeze').hidden = !sq;
    if (sq) $('cqSqueeze').replaceChildren('Squeezed for the drive: ', el('b', { text: `${built.before.layers} → ${built.layers} layers, ${built.before.bytes} → ${built.bytes} bytes` }),
      '. Effects that are the same at other times play as one layer again, and the layers are in the order that takes the fewest bytes. The drive shows exactly the same (checked frame by frame).');
    const h = heard.hits;
    $('cqHeard').textContent = song && h
      ? `The song as the drive hears it in the simulated ${song.roomName || 'club'} (the room picked in Song moments): ${h.kick.filter((b) => b >= 0 && b < viewBeats()).length} kicks and ${h.snare.filter((b) => b >= 0 && b < viewBeats()).length} snares in these ${viewBeats() / 4} bars. The drive plays the effects on its own beat clock, so they can land a little off the song's grid.`
      : '';
  }

  // Taps that line up with the kicks or snares the drive hears: offer to make them one effect.
  function foldBox() {
    const box = $('cqFold');
    box.hidden = !offers.length;
    box.replaceChildren(...offers.map((o) => {
      const btn = el('button', { class: 'btn', type: 'button', text: 'Make it one effect' });
      btn.addEventListener('click', () => {
        change(() => { C.foldTracks(tracks, offerCues, o); sel = { row: 0, group: 0, i: 0 }; });
        message('ok', el('strong', { text: 'Done. ' }), `${o.indexes.length} pulses are now one effect on a new layer: ${C.KINDS[o.cue.kind].name.toLowerCase()} from ${C.whereText(o.cue.at)} for ${C.beatsText(o.cue.for)} beats.`);
      });
      return el('div', { class: 'cq-offer' }, el('span', { text: `${o.text}. One effect instead of ${o.indexes.length}, and it follows the drive's own ears.` }), btn);
    }));
  }

  // ---------------------------------------------------------------- the timeline
  const headW = () => { const h = $('cqSheet').querySelector('.cq-head'); return h ? h.offsetWidth : 210; };
  function ppb() {   // pixels a beat
    const vis = Math.max(200, $('cqScroll').clientWidth - headW());
    return vis / (ZOOMS[zoom] * 4);
  }
  const laneW = () => Math.max(Math.round(viewBeats() * ppb()), $('cqScroll').clientWidth - headW());
  const clipAt = (c) => { const r = tracks.rows[c.row], g = r && r.groups[c.group]; return g && g.at[c.i] !== undefined ? { r, g, at: g.at[c.i] } : null; };
  // the colour a placed effect is drawn in on its row
  function clipColour(r, g) {
    const k = C.KINDS[r.kind];
    if (k.recolour) {
      const ps = C.PARTS.filter((p) => g.look.zones.includes(p)).map((p) => C.hex(g.look.paint[p].colour));
      return { bg: `linear-gradient(to bottom, ${(ps.length ? ps : ['#555555']).join(', ')})`, c: ps[0] || '#555555' };
    }
    if (r.kind === 'cut') return { c: '#6b625b' };
    if (!k.colour) return { c: '#f1eae3' };
    return { c: C.hex(g.look.colour) };
  }
  function renderSheet() {
    const off = !song || $('cqBody').hidden;
    $('cqTimeline').hidden = off;
    $('cqPlaceHere').disabled = !chosen;
    $('cqZoomText').textContent = `${ZOOMS[zoom]} bars`;
    if (off) return;
    const p = ppb(), w = laneW(), sheet = $('cqSheet');
    sheet.style.setProperty('--beat', `${p}px`);
    sheet.style.setProperty('--bar', `${p * 4}px`);
    sheet.querySelectorAll('.cq-lane').forEach((l) => { l.style.width = `${w}px`; });
    // the ruler: bar numbers
    const ruler = $('cqRuler'), step = p * 4 < 26 ? Math.ceil(26 / (p * 4)) : 1;
    ruler.style.width = `${w}px`;
    ruler.replaceChildren(...Array.from({ length: Math.ceil(w / (p * 4)) }, (_, b) => b).filter((b) => b % step === 0)
      .map((b) => el('span', { text: String(b + 1), style: `left:${b * 4 * p}px` })));
    // a row for each layer, the top one first
    $('cqRows').replaceChildren(...tracks.rows.map((r, ri) => rowEl(r, ri, p, w)));
  }
  function rowEl(r, ri, p, w) {
    const k = C.KINDS[r.kind];
    const handle = el('span', { class: 'cq-handle', title: 'Drag to move this layer up or down (higher layers draw over lower ones)', text: '⠿', 'aria-hidden': 'true' });
    const name = el('input', { class: 'cq-name', type: 'text', value: r.name, maxlength: '40', 'aria-label': `Layer name (${k.name})`, title: `${k.name}: ${k.says}` });
    name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== r.name) change(() => { r.name = v; }); else name.value = r.name; });
    const mute = el('button', { class: 'btn quiet', type: 'button', text: r.muted ? 'Muted' : 'Mute', 'aria-pressed': String(r.muted), title: 'Left out of the animation and its bytes while muted' });
    mute.addEventListener('click', () => change(() => { r.muted = !r.muted; }));
    const up = el('button', { class: 'btn quiet', type: 'button', text: '↑', 'aria-label': `Move "${r.name}" up` });
    up.disabled = ri === 0;
    up.addEventListener('click', () => change(() => { C.moveRow(tracks, ri, -1); sel = null; }));
    const down = el('button', { class: 'btn quiet', type: 'button', text: '↓', 'aria-label': `Move "${r.name}" down` });
    down.disabled = ri === tracks.rows.length - 1;
    down.addEventListener('click', () => change(() => { C.moveRow(tracks, ri, 1); sel = null; }));
    const del = el('button', { class: 'btn quiet', type: 'button', text: '✕', 'aria-label': `Delete the layer "${r.name}"` });
    del.addEventListener('click', () => {
      const n = r.groups.reduce((s, g) => s + g.at.length, 0);
      if (n && !confirm(`Delete the layer "${r.name}" and its ${n} effect${n === 1 ? '' : 's'}?`)) return;
      change(() => { tracks.rows.splice(ri, 1); sel = null; if (chosen === r.id) chosen = null; });
    });
    const nl = costs[r.id] || 0;
    const cost = el('span', { class: `cq-cost${nl >= 4 ? ' big' : ''}`, text: `${nl}`, title: costText(r, nl), 'aria-label': costText(r, nl) });
    const head = el('div', { class: 'cq-head' }, handle, name, cost, mute, up, down, del);
    head.addEventListener('click', (e) => { if (e.target === head || e.target === handle) chooseRow(r.id); });
    rowDrag(handle, ri);
    const lane = el('div', { class: 'cq-lane', style: `width:${w}px`, 'aria-label': `${r.name}: double-click to put ${k.name.toLowerCase()} there` });
    r.groups.forEach((g, gi) => g.at.forEach((at, i) => lane.append(clipEl(r, ri, g, gi, at, i, p))));
    lane.addEventListener('pointerdown', (e) => { if (!e.target.closest('.cq-clip')) chooseRow(r.id, true); });
    lane.addEventListener('dblclick', (e) => {
      if (e.target.closest('.cq-clip') || mode === 'record') return;
      const b = C.snapTo((e.clientX - lane.getBoundingClientRect().left) / ppb(), snapStep());
      putOn(ri, b);
    });
    return el('div', { class: `cq-row${r.muted ? ' muted' : ''}${chosen === r.id ? ' chosen' : ''}`, 'data-row': String(ri) }, head, lane);
  }
  // what a row's tag means: how many layers of animation it makes, and why
  function costText(r, nl) {
    if (r.muted) return 'Muted: no layers of animation.';
    const why = { recolour: ' A Recolour is up to 3 for each colour it uses (fade in, hold, fade out).', white: ' A white pulse that comes in is 2 (in, then out); one with a sweep is 2.' }[r.kind] || '';
    const sets = r.groups.length;
    return `Makes ${nl} layer${nl === 1 ? '' : 's'} of animation (of the ${C.MAX_LAYERS} a drive plays, before squeezing).${why}${sets > 1 ? ` It has ${sets} different looks: each is layers of its own (linked copies of one look share them).` : ''}`;
  }
  function chooseRow(id, keep = false) {
    const was = chosen;
    chosen = keep ? id : chosen === id ? null : id;
    if (chosen === was && !sel) return;
    sel = null;
    // (marked in place: a re-drawn row would lose the second click of a double-click)
    document.querySelectorAll('#cqRows .cq-row').forEach((x, ri) => x.classList.toggle('chosen', !!tracks.rows[ri] && tracks.rows[ri].id === chosen));
    document.querySelectorAll('#cqRows .cq-clip.sel').forEach((x) => x.classList.remove('sel'));
    $('cqPlaceHere').disabled = !chosen;
    inspector();
    if (chosen) message('', `Layer "${tracks.rows[rowIndex(chosen)].name}" chosen: Record records into it, and double-click (or Put it at the playhead) adds its effect.`);
  }
  function putOn(ri, b) {
    const r = tracks.rows[ri];
    change(() => { sel = C.place(tracks, ri, Math.max(0, b), lookFor(r, r.kind)); chosen = r.id; });
    message('ok', el('strong', { text: C.KINDS[r.kind].name }), ` at ${C.whereText(Math.max(0, b))}.`);
  }
  function clipEl(r, ri, g, gi, at, i, p) {
    const k = C.KINDS[r.kind], col = clipColour(r, g), n = g.at.length;
    const d = el('div', {
      class: `cq-clip${sel && sel.row === ri && sel.group === gi && sel.i === i ? ' sel' : ''}`,
      style: `left:${at * p}px;width:${Math.max(6, g.look.for * p)}px;--c:${col.c};${col.bg ? `background:${col.bg};` : ''}`,
      title: `${k.name}, ${C.whereText(at)}, ${C.beatsText(g.look.for)} beat${g.look.for === 1 ? '' : 's'}${n > 1 ? `; linked with ${n - 1} other cop${n === 2 ? 'y' : 'ies'}` : ''}. Drag to move, drag an end to change its length, Alt-drag to copy.`,
      role: 'button', tabindex: '0', 'aria-label': `${k.name} at ${C.whereText(at)}`,
    }, el('span', { class: 'grip l' }), el('span', { text: k.name }), ...(n > 1 ? [el('span', { class: 'cq-link', text: `×${n}` })] : []), el('span', { class: 'grip r' }));
    d.addEventListener('pointerdown', (e) => clipDrag(e, d, { row: ri, group: gi, i }));
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter') select({ row: ri, group: gi, i }); });
    return d;
  }
  function select(c) { sel = c; chosen = tracks.rows[c.row].id; renderSheet(); inspector(); }

  // dragging an effect: move it, or an end to change its length (all its linked copies), Alt: copy
  function clipDrag(e, d, c) {
    if (mode === 'record' || e.button !== 0) return;
    e.preventDefault();
    const x = clipAt(c);
    if (!x) return;
    select(c);
    const target = document.querySelector(`.cq-row[data-row="${c.row}"] .cq-clip.sel`) || d;
    const edge = e.target.classList.contains('grip') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const copy = e.altKey && !edge, x0 = e.clientX, at0 = x.at, len0 = x.g.look.for, p = ppb();
    let at = at0, len = len0, moved = false;
    target.setPointerCapture(e.pointerId);
    const ghost = copy ? target.cloneNode(true) : null;
    if (ghost) { ghost.classList.add('sel'); target.parentNode.append(ghost); }
    const shown = ghost || target;
    const onMove = (ev) => {
      const db = C.snapTo((ev.clientX - x0) / p, snapStep());
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (edge === 'r') len = Math.max(snapStep(), C.snapTo(len0 + db, snapStep()));
      else if (edge === 'l') { const nb = Math.max(0, Math.min(at0 + len0 - snapStep(), at0 + db)); len = at0 + len0 - nb; at = nb; }
      else at = Math.max(0, C.snapTo(at0 + db, snapStep()));
      shown.style.left = `${at * p}px`;
      shown.style.width = `${Math.max(6, len * p)}px`;
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      if (ghost) ghost.remove();
      if (!moved) { renderSheet(); return; }
      change(() => {
        if (copy) sel = C.copyClip(tracks, c, at);
        else {
          if (len !== len0) C.setLook(tracks, c, { for: len });
          if (at !== at0) sel = C.moveClip(tracks, c, at);
        }
      });
      const n = clipAt(sel).g.at.length;
      message('ok', copy ? `Copied to ${C.whereText(at)}: ${n} linked copies (change one, they all change).`
        : edge ? `${C.beatsText(len)} beat${len === 1 ? '' : 's'} long${n > 1 ? `, and so are its ${n - 1} linked copies` : ''}.` : `Moved to ${C.whereText(at)}.`);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  // dragging a layer by its handle: drop it above another (or at the bottom)
  function rowDrag(handle, ri) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const rowsEl = [...$('cqRows').children];
      rowsEl[ri].classList.add('drag');
      let to = ri;
      const onMove = (ev) => {
        rowsEl.forEach((x) => x.classList.remove('drop-above'));
        to = rowsEl.findIndex((x) => ev.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
        if (to < 0) to = rowsEl.length;
        if (rowsEl[to]) rowsEl[to].classList.add('drop-above');
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        const dest = to > ri ? to - 1 : to;
        if (dest !== ri) change(() => { C.moveRow(tracks, ri, dest - ri); sel = null; });
        else renderSheet();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  // ---------------------------------------------------------------- the selected effect
  function inspector() {
    const box = $('cqInspect');
    const x = sel && clipAt(sel);
    box.hidden = !x || !song;
    if (!x) { box.replaceChildren(); return; }
    const { r, g, at } = x, k = C.KINDS[r.kind], lk = g.look, n = g.at.length;
    const set = (chg) => change(() => { sel = C.setLook(tracks, sel, chg); });
    const num = (value, min, step, label, onSet) => {
      const i = el('input', { type: 'number', min: String(min), step: String(step), value: String(value), 'aria-label': label });
      i.addEventListener('change', () => onSet(Math.max(min, C.snapTo(Number(i.value) || min, C.STEP))));
      return i;
    };
    const pick = (options, value, label, onSet) => {
      const s = el('select', { 'aria-label': label }, ...options.map(([v, t]) => el('option', { value: String(v), text: t })));
      s.value = String(value);
      s.addEventListener('change', () => onSet(s.value));
      return s;
    };
    const rows = [];
    rows.push(el('div', { class: 'rt-controls' },
      el('label', {}, 'Starts ', num(at, 0, C.STEP, 'Starts, beats from the start', (v) => change(() => { sel = C.moveClip(tracks, sel, v); }))),
      el('span', { class: 'note', text: C.whereText(at) }),
      el('label', {}, 'Length ', num(lk.for, C.STEP, C.STEP, 'Length in beats', (v) => set({ for: v })), ' beats'),
      el('span', { class: 'note', text: n > 1 ? `Linked: ${n} copies. Change one and they all change.` : 'Not linked to any copy.' }),
      ...(n > 1 ? [btn('Make this one separate', () => { change(() => { sel = C.separate(tracks, sel); }); message('ok', 'This one has its own settings now.'); })] : [])));
    // which LEDs
    const zoneBoxes = C.PARTS.map((p) => {
      const b = el('input', { type: 'checkbox', 'aria-label': C.ZONE_NAMES[p] });
      b.checked = lk.zones.includes(p);
      b.addEventListener('change', () => {
        const z = C.PARTS.filter((q) => (q === p ? b.checked : lk.zones.includes(q)));
        if (!z.length) { b.checked = true; return message('bad', 'Tick at least one of top, middle and bottom.'); }
        set({ zones: z });
      });
      return b;
    });
    if (k.recolour) {
      rows.push(el('div', { class: 'rt-controls' }, ...C.PARTS.map((p, j) => {
        const pt = lk.paint[p];
        const col = el('input', { type: 'color', value: C.hex(pt.colour), 'aria-label': `${C.ZONE_NAMES[p]} colour` });
        col.addEventListener('change', () => set({ paint: { ...lk.paint, [p]: { ...pt, colour: C.rgbOf(col.value) } } }));
        const lv = el('input', { type: 'range', min: '0', max: '200', step: '5', value: String(pt.level), 'aria-label': `${C.ZONE_NAMES[p]} brightness` });
        const lt = el('span', { class: 'cq-pct', text: `${pt.level}%` });
        lv.addEventListener('input', () => { lt.textContent = `${lv.value}%`; });
        lv.addEventListener('change', () => set({ paint: { ...lk.paint, [p]: { ...pt, level: Number(lv.value) } } }));
        return el('span', { class: 'cq-zonepaint' }, el('label', {}, zoneBoxes[j], ` ${C.ZONE_NAMES[p]}`), col, lv, lt);
      })));
      rows.push(el('div', { class: 'rt-controls' },
        el('label', {}, 'Fades in over ', pick(SPANS, lk.in, 'Fade in', (v) => set({ in: Number(v) }))),
        el('label', {}, 'fades out over ', pick(SPANS, lk.out, 'Fade out', (v) => set({ out: Number(v) }))),
        el('span', { class: 'note', text: 'Brightness: 100 % is the normal look\'s, lower is darker, above 100 % brighter (200 %: full). The look keeps moving under it, and its kicks pulse in the new colour.' })));
    } else {
      const parts = [el('span', {}, 'LEDs '), ...C.PARTS.map((p, j) => el('label', {}, zoneBoxes[j], ` ${C.ZONE_NAMES[p]} `))];
      if (k.colour) {
        const col = el('input', { type: 'color', value: C.hex(lk.colour), 'aria-label': 'Colour' });
        col.addEventListener('change', () => set({ colour: C.rgbOf(col.value) }));
        parts.push(el('label', {}, 'Colour ', col));
      }
      if (!k.hits && r.kind !== 'cut') {
        const lv = el('input', { type: 'range', min: '0', max: '100', value: String(lk.level), 'aria-label': 'Brightness' });
        const lt = el('span', { class: 'cq-pct', text: `${lk.level}%` });
        lv.addEventListener('input', () => { lt.textContent = `${lv.value}%`; });
        lv.addEventListener('change', () => set({ level: Number(lv.value) }));
        parts.push(el('label', {}, 'Brightness ', lv, lt));
      }
      if (k.hits) parts.push(el('span', { class: 'note', text: `As bright as the drive hears each ${k.hits}: a harder hit flashes brighter.` }));
      rows.push(el('div', { class: 'rt-controls' }, ...parts));
      if (k.shape || k.curve) {
        const shape = [];
        if (k.shape) shape.push(el('label', {}, 'Comes in ', pick(SPANS.filter(([v]) => v < lk.for), lk.in, 'How fast it comes in', (v) => set({ in: Number(v) }))));
        shape.push(el('label', {}, k.shape ? 'fades out ' : 'Curve ', pick(Object.entries(C.CURVE_NAMES), lk.curve, 'How it fades', (v) => set({ curve: v }))));
        if (k.shape) {
          shape.push(el('label', {}, 'Sweep ', pick(Object.entries(C.SWEEPS), lk.sweep, 'Sweep', (v) => set({ sweep: v }))));
          if (lk.sweep !== 'none') shape.push(el('label', {}, 'across the drive in ', pick(SPANS.slice(1), lk.spread, 'How long the sweep takes', (v) => set({ spread: Number(v) }))));
        }
        rows.push(el('div', { class: 'rt-controls' }, ...shape));
      }
    }
    // copies
    const every = pick(EVERY, 1, 'Copies every', () => {});
    const many = el('input', { type: 'number', min: '1', max: '63', step: '1', value: '3', 'aria-label': 'How many copies' });
    rows.push(el('div', { class: 'rt-controls' },
      btn('Copy after it', () => {
        const t = C.snapTo(at + lk.for, snapStep());
        change(() => { sel = C.copyClip(tracks, sel, t); });
        message('ok', `A linked copy at ${C.whereText(t)}.`);
      }),
      el('span', {}, 'Add copies every '), every, el('span', {}, ' × '), many,
      btn('Add', () => {
        const e2 = Number(every.value), k2 = Math.max(1, Math.min(63, Math.round(Number(many.value) || 1)));
        change(() => { for (let j = 1; j <= k2; j++) C.copyClip(tracks, sel, at + j * e2); });
        message('ok', `${k2} linked cop${k2 === 1 ? 'y' : 'ies'}, one every ${EVERY.find(([v]) => v === e2)[1]}: the drive plays them as one layer, about a byte each.`);
      }),
      btn('Delete this one', () => { change(() => { C.deleteClip(tracks, sel); sel = null; }); }),
      ...(n > 1 ? [btn(`Delete all ${n} copies`, () => { change(() => { tracks.rows[sel.row].groups.splice(sel.group, 1); sel = null; }); })] : [])));
    box.replaceChildren(el('h3', { text: `${k.name} on "${r.name}"` }), ...rows);
  }
  function btn(text, onClick) {
    const b = el('button', { class: 'btn quiet', type: 'button', text });
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------------------------------------------------------------- strips under the rows
  function drawStrips() {
    if (!song || !look || $('cqTimeline').hidden || !$('cqScroll').clientWidth) return;
    const w = laneW(), span = (w / ppb()) * beatS() * 1000;
    for (const [id, fn] of [['cqStripLook', lookAt], ['cqStripDrive', (ms) => driveAt(show, ms)]]) {
      const cv = $(id);
      cv.style.width = `${w}px`;
      stripOn(cv, span, fn);
    }
    drawWave(w);
    drawHits(w);
  }
  // the song's waveform over the timeline (as in Song moments: each pixel the loudest and quietest
  // sample there, and brighter, how loud it is on average), with the bars; before the start and
  // after the song's end it's empty
  function drawWave(wCss) {
    const cv = $('cqWave'), dpr = window.devicePixelRatio || 1;
    cv.style.width = `${wCss}px`;
    const w = Math.max(1, Math.min(MAX_STRIP_PX, Math.round(wCss * dpr))), hgt = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = hgt;
    const g = cv.getContext('2d'), n = wCss / ppb(), a = song.audio, rate = song.rate;
    const X = (b) => Math.round((b / n) * w), mid = hgt / 2, half = hgt / 2 - 2 * dpr;
    for (let bar = 0; bar < n / 4; bar++) { g.fillStyle = 'rgba(241,234,227,0.16)'; g.fillRect(X(bar * 4), 0, 1, hgt); }
    if (!song.peak) { let p = 0; for (let i = 0; i < a.length; i += 7) p = Math.max(p, Math.abs(a[i])); song.peak = p || 1; }
    const k = half / song.peak, per = (n * beatS() * rate) / w, from = start * rate;
    for (let x = 0; x < w; x++) {
      const i0 = Math.max(0, Math.floor(from + x * per)), i1 = Math.min(a.length, Math.floor(from + (x + 1) * per));
      if (i1 <= i0) continue;
      let lo = 0, hi = 0, sq = 0, m = 0;
      for (let i = i0, st = Math.max(1, Math.floor((i1 - i0) / 400)); i < i1; i += st, m++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; sq += v * v; }
      const rms = Math.sqrt(sq / m);
      g.fillStyle = '#7d726a'; g.fillRect(x, mid - hi * k, 1, Math.max(1, (hi - lo) * k));
      g.fillStyle = 'rgba(241,234,227,0.55)'; g.fillRect(x, mid - rms * k, 1, Math.max(1, 2 * rms * k));
    }
  }
  // like tab.stripOn, with the canvas no wider than MAX_STRIP_PX
  function stripOn(cv, len, frameFn) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(MAX_STRIP_PX, Math.round(cv.clientWidth * dpr))), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), rh = h / ledRows.length;
    for (let x = 0; x < w; x++) {
      const px = frameFn(Math.floor((x / w) * len));
      ledRows.forEach((led, r) => { g.fillStyle = `rgb(${px[led].join(',')})`; g.fillRect(x, r * rh, 1, Math.ceil(rh)); });
    }
  }
  // the kicks (upper half) and snares (lower half) the drive hears
  function drawHits(wCss) {
    const cv = $('cqHits'), dpr = window.devicePixelRatio || 1;
    cv.style.width = `${wCss}px`;
    const w = Math.max(1, Math.min(MAX_STRIP_PX, Math.round(wCss * dpr))), hgt = Math.max(1, Math.round(cv.clientHeight * dpr));
    cv.width = w; cv.height = hgt;
    const g = cv.getContext('2d'), n = wCss / ppb(), X = (b) => Math.round((b / n) * w);
    const css = getComputedStyle(document.documentElement);
    const paper = css.getPropertyValue('--paper').trim() || '#f1eae3', resin = css.getPropertyValue('--resin').trim() || '#ff8a2a';
    const half = hgt / 2, mark = (b, top, colour) => { if (b < 0 || b > n) return; g.fillStyle = colour; g.fillRect(X(b) - dpr, top + 3 * dpr, 2 * dpr, half - 6 * dpr); };
    for (let bar = 0; bar < n / 4; bar++) { g.fillStyle = 'rgba(241,234,227,0.16)'; g.fillRect(X(bar * 4), 0, 1, hgt); }
    for (const b of heard.hits ? heard.hits.kick : []) mark(b, 0, paper);
    for (const b of heard.hits ? heard.hits.snare : []) mark(b, half, resin);
  }
  function draw() {
    if (!song || $('cqBody').hidden) { tab.light(lens, DARK()); $('cqClock').textContent = ''; $('cqHead').hidden = true; return; }
    const s = songNow(), b = beatsAt(s), ms = (s - start) * 1000;
    const sh = mode === 'record' ? liveShow() : show;
    tab.light(lens, driveAt(sh, ms));
    const toGo = Math.ceil(-b - 1e-9);
    const where = b < 0 ? `lead-in, ${toGo} beat${toGo === 1 ? '' : 's'} to go` : C.whereText(Math.floor(b * 4) / 4);
    $('cqClock').textContent = `${fmt(s)} · ${where}`;
    const head = $('cqHead'), w = laneW();
    head.hidden = $('cqTimeline').hidden || b < 0 || b * ppb() > w;
    head.style.left = `${headW() + b * ppb()}px`;
    // keep the playhead in sight while playing
    if (src && !head.hidden) {
      const sc = $('cqScroll'), x = b * ppb(), visW = sc.clientWidth - headW();
      if (x < sc.scrollLeft || x > sc.scrollLeft + visW - 40) sc.scrollLeft = Math.max(0, x - 40);
    }
  }

  let frames = 0;
  function tick() {
    const visible = !$('p-routines').hidden;
    // a song opened (or its beats changed) in Song moments: about twice a second
    if (visible && mode === 'stop' && tab.family() === 'pulse' && ++frames % 30 === 0) pickSong();
    if (!visible && mode !== 'stop') stop();
    if (visible && src) {
      const b = beatsAt(songNow());
      if (mode === 'play' && b > viewBeats() + 4) stop();
      draw();
    }
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------- keys
  const typing = (t) => t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'INPUT' && !/^(range|color|checkbox|radio|button)$/.test(t.type)));
  document.addEventListener('keydown', (e) => {
    if ($('p-routines').hidden || $('cqBody').hidden || !song || e.altKey || typing(e.target)) return;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if ((e.metaKey || e.ctrlKey) && key === 'Z' && mode !== 'record') { e.preventDefault(); undo(); return; }
    if (e.metaKey || e.ctrlKey) return;
    if (key === 'Escape' && mode !== 'stop') { stop(); e.preventDefault(); return; }
    if (/^[1-4]$/.test(key)) { $('cqZone').value = C.ZONES[Number(key) - 1]; e.preventDefault(); return; }
    if (mode !== 'record') {
      if ((key === 'Delete' || key === 'Backspace') && sel) { e.preventDefault(); change(() => { C.deleteClip(tracks, sel); sel = null; }); }
      return;
    }
    if (C.KIND_BY_KEY[key]) { e.preventDefault(); if (!e.repeat) keyDown(key); }
    else if (key === 'Z' || key === 'Backspace') { e.preventDefault(); undo(); }
  });
  document.addEventListener('keyup', (e) => {
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (held.has(key)) keyUp(key);
  });
  window.addEventListener('blur', () => { for (const k of [...held.keys()]) keyUp(k); });

  // ---------------------------------------------------------------- controls
  $('cqKeys').replaceChildren(...Object.values(C.KINDS).filter((k) => k.key).map((k) =>
    el('span', { class: 'cq-key', 'data-key': k.key, title: `${k.name}: ${k.says}` }, el('kbd', { text: k.key }), ` ${k.name}`)));
  $('cqAddKind').replaceChildren(...Object.entries(C.KINDS).map(([v, k]) => el('option', { value: v, text: k.name })));
  $('cqAddRow').addEventListener('click', () => {
    const kind = $('cqAddKind').value;
    change(() => { tracks.rows.unshift(C.newRow(tracks, kind)); chosen = tracks.rows[0].id; sel = null; });
    message('', `Added the layer "${tracks.rows[0].name}" at the top. Double-click on it where the effect should go, or press Put it at the playhead.`);
  });
  $('cqPlaceHere').addEventListener('click', () => { const ri = rowIndex(chosen); if (ri >= 0) putOn(ri, C.snapTo(Math.max(0, beatsAt(pos)), snapStep())); });
  $('cqZoomIn').addEventListener('click', () => { if (zoom > 0) { zoom--; renderSheet(); drawStrips(); draw(); } });
  $('cqZoomOut').addEventListener('click', () => { if (zoom < ZOOMS.length - 1) { zoom++; renderSheet(); drawStrips(); draw(); } });
  $('cqRuler').addEventListener('pointerdown', (e) => {
    if (!song) return;
    const b = Math.max(0, (e.clientX - $('cqRuler').getBoundingClientRect().left) / ppb());
    const playing = mode === 'play';
    if (mode === 'record') return;
    stop();
    pos = songAt(C.snapTo(b, C.STEP));
    draw();
    if (playing) go('play');
  });
  $('cqRecord').addEventListener('click', () => { if (mode === 'record') return stop(); pickSong(); go('record'); });
  $('cqPlay').addEventListener('click', () => { if (mode === 'play') return stop(); pickSong(); go('play'); });
  $('cqUndo').addEventListener('click', undo);
  $('cqClear').addEventListener('click', () => {
    if (!tracks.rows.length) return;
    if (!confirm(`Delete all ${tracks.rows.length} layers and their effects?`)) return;
    change(() => { tracks.rows = []; sel = null; chosen = null; });
    message('', 'All layers deleted (Undo brings them back).');
  });
  $('cqUsePlay').addEventListener('click', () => { if (song && song.playAt != null) { start = song.playAt; pos = start; rebuild(); } });
  $('cqEarlier').addEventListener('click', () => { if (song) { start = Math.max(0, start - beatS()); pos = start; rebuild(); } });
  $('cqLater').addEventListener('click', () => { if (song) { start = Math.min(song.duration, start + beatS()); pos = start; rebuild(); } });
  $('cqLevel').addEventListener('input', () => { $('cqLevelText').textContent = `${$('cqLevel').value}%`; });
  $('cqUnderLevel').addEventListener('input', () => { $('cqUnderText').textContent = `${$('cqUnderLevel').value}%`; });
  for (const id of ['cqUnder', 'cqUnderLevel']) $(id).addEventListener('change', () => change(() => {}));
  $('cqUnderMode').addEventListener('change', () => { $('cqUnderColour').hidden = $('cqUnderMode').value !== 'colour'; change(() => {}); });
  $('cqName').addEventListener('change', rebuild);
  window.addEventListener('resize', () => { if (song && !$('cqTimeline').hidden) { renderSheet(); drawStrips(); draw(); } });
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
    if (!recipe()) return saveMsg('Put some effects on the timeline first.');
    if (!state.library) return saveMsg('Choose a library folder first (Library tab, Choose library folder). Animations are kept in its animations folder.');
    try {
      const { animation, file, replaced } = await state.library.saveAnimation(recipe(), $('cqName').value);
      $('cqName').value = animation.name;
      rebuild();
      tab.lab.reload();
      listSaved();
      await tab.moments.useAnimation(animation.name);
      saveMsg(`Saved "${animation.name}" as animations/${file}${replaced ? ', replacing the one saved before' : ''}${state.library.saved ? '' : ' (demo library: lost when you close the page)'}, with its layers, so it opens here again. It's now the animation in Song moments above: press Play there to see it where the drive recognises the song, then Save song moment.`);
    } catch (e) { saveMsg(e.message); }
  });
  // saved animations made here (they keep their tracks) open again as tracks
  let savedList = [];
  async function listSaved() {
    savedList = [];
    try { savedList = state.library ? (await state.library.animations('pulse')).filter((a) => a.tracks && C.cleanTracks(a.tracks)) : []; } catch {}
    $('cqOpenSel').replaceChildren(el('option', { value: '', text: savedList.length ? 'Choose one' : 'None saved yet' }), ...savedList.map((a, i) => el('option', { value: String(i), text: a.name })));
    $('cqOpen').disabled = !savedList.length;
  }
  $('cqOpen').addEventListener('click', () => {
    const a = savedList[Number($('cqOpenSel').value)];
    if (!a || !$('cqOpenSel').value) return saveMsg('Choose a saved timeline first.');
    stop();
    change(() => { tracks = C.cleanTracks(a.tracks); sel = null; chosen = null; });
    underToControls();
    $('cqName').value = a.name;
    rebuild();
    saveMsg(`Opened "${a.name}" (Undo goes back to what was here).`);
  });

  // For the headless checks: put tracks on without a mouse, choose and select, stop the clock.
  window.synaptoCues = {
    load(t) { change(() => { tracks = C.cleanTracks(t) || C.emptyTracks(); sel = null; }); underToControls(); },
    tracks: () => JSON.parse(JSON.stringify(tracks)),
    recipe: () => recipe(),
    select: (row, group = 0, i = 0) => select({ row, group, i }),
    choose: (row) => chooseRow(tracks.rows[row].id, true),
    at(s) { stop(); pos = s; draw(); },
    beatsToX: (b) => headW() + b * ppb(),
    playhead: () => (song ? beatsAt(pos) : null),
    hits: () => heard.hits,
    offers: () => offers.map((o) => o.text),
    built: () => (built ? { layers: built.layers, bytes: built.bytes } : null),
    press: keyDown, release: keyUp, record: () => go('record'), stop,
  };

  requestAnimationFrame(tick);
  function reload() {
    tab.buildBoard($('cqBoard'), lens);
    ledRows = drawnLeds(tab.profile()).map((q) => q.led - 1).reverse();
    if (tab.family() !== 'pulse') { stop(); status(); return; }
    pickSong();
    listSaved();
    rebuild();
  }
  underToControls();
  return { reload, refresh: () => { if (song && mode === 'stop') rebuild(); }, redraw: () => { renderSheet(); drawStrips(); draw(); } };
}
