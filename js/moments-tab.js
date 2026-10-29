// The Song moments screen in the Routines tab (roadmap R4), Pulse only. Add a song clip (copied
// into the library's songs/ folder, never uploaded), see its waveform with beats and bars, drag
// "Listen for" (what the drive learns) and "Play at" (when the animation starts), pick an
// animation, preview it with the song through the simulated mic, and save it to moments/.
// Under the message: the quietest room the drive still hears the moment in (firmware R5c).
// The maths is js/moments.js; the slow parts (learning, the quietest room) run in js/moments-worker.js.

import * as pulse from './preview-pulse.js';
import { Show, makeDrive, length, normalise } from './player.js';
import { dropExample, pulseMusic, pulseAmbient } from './animations.js';
import { listen } from './songs.js';
import * as M from './moments.js';

const RATE = M.RATE;
const PREROLL = 1;   // s of room before the music in the preview (the drive is plugged in at 0)
const LEAD = 12;     // s of music the preview hears before it shows anything, so the beat is found
const BEAT = 16384;  // one beat in the player's beat clock
const fmt = M.fmtTime;

export function initSongMoments({ $, el, state, tab }) {
  // tab: { family(), settings(f), profile(), buildBoard(box, lensEls), light(lensEls, px) }
  let song = null;     // { name, audio (mono, RATE), buffer (to play), duration, inLibrary, bytes, peaks }
  let grid = null;     // { bpm, firstBar }
  let marks = null;    // { from, to, playAt } in s: listening, and when the animation starts
  let bars = M.LISTEN_BARS.start;
  let learnt = null;   // what learnMoment said, with the marks it was for (key); .quiet: what quietestRoom said ('working' till then)
  let checked = null;  // { key, passed: [names], fired: [{ name, at }] } from "Check against my other songs"
  let view = { from: 0, to: 20 };
  let pv = null;       // the preview: the song heard through the simulated mic around the moment
  let pt = 0, playing = false, last = null;
  let pending = Promise.resolve();
  const lens = [];

  const beat = () => M.beatSec(grid);
  const keyOf = () => (song && marks ? `${song.name}|${marks.from.toFixed(3)}|${marks.to.toFixed(3)}` : '');
  const learntNow = () => !!learnt && learnt.key === keyOf();
  const learntOk = () => learntNow() && learnt.ok;

  // ---------------------------------------------------------------- the worker
  let worker = null, quietWorker = null, nextId = 1;
  const jobs = new Map(), here = new Map();
  function runHere(op, d) {
    if (op === 'clip') { here.set(d.clip, d.audio); return true; }
    if (op === 'grid') { const g = M.beatGrid(here.get(d.clip), RATE); return { grid: g, drop: M.findDrop(here.get(d.clip), RATE, g) }; }
    if (op === 'learn') return M.learnMoment(here.get(d.clip), RATE, d.marks);
    if (op === 'check') return M.checkOther(d.moment, d.audio, RATE);
    if (op === 'quiet') return M.quietestRoom(d.audio, RATE, d.print, d.marks);
  }
  // Two workers: the quietest room takes a few seconds, and learning shouldn't wait for it.
  const onDone = (e) => { const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id); e.data.error ? j.rej(new Error(e.data.error)) : j.res(e.data.out); };
  function startWorker(quiet) {
    try {
      const w = new Worker(new URL('./moments-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = onDone;
      w.onerror = () => {
        if (quiet) quietWorker = null; else worker = null;
        for (const [id, j] of jobs) if ((j.op === 'quiet') === quiet) { jobs.delete(id); work(j.op, j.d).then(j.res, j.rej); }
      };
      return w;
    } catch { return null; }
  }
  worker = startWorker(false);
  quietWorker = worker && startWorker(true);
  function work(op, d = {}) {
    if (op === 'clip') here.set(d.clip, d.audio);   // kept here too, in case the worker can't start
    const w = op === 'quiet' ? quietWorker : worker;
    if (w) return new Promise((res, rej) => { const id = nextId++; jobs.set(id, { res, rej, op, d }); w.postMessage({ id, op, rate: RATE, ...d }); });
    return new Promise((res) => setTimeout(res, 20)).then(() => runHere(op, d));
  }

  // ---------------------------------------------------------------- messages
  function message(kind, ...parts) { const b = $('smMsg'); b.className = `lab-msg ${kind}`; b.replaceChildren(...parts); }
  const saveMsg = (text) => { $('smSaveMsg').textContent = text; };
  function status() {
    if (!song) return message('', 'Add a song clip, or choose one from the library\'s songs folder.');
    if (!learntNow()) return message('', el('strong', { text: 'Learning what the drive listens for… ' }), 'It plays the bars through the simulated mic 16 times, in 4 rooms. A second or two.');
    if (!learnt.ok) return message('bad', el('strong', { text: 'The drive can\'t use this yet. ' }), learnt.problem);
    const parts = [el('strong', { text: 'Learnt. ' }),
      `The drive recognised it in ${learnt.heard} of ${learnt.hearings} simulated rooms, by ${fmt(learnt.recognisedAt)}, so Play at can be ${fmt(M.earliestPlay(grid, learnt.recognisedAt))} or later. It keeps ${learnt.bytes} bytes for this moment.`];
    if (learnt.warning) parts.push(el('span', { class: 'lab-warn', text: learnt.warning }));
    const also = learnt.alsoHeardAt.map((t) => fmt(t + marks.playAt - marks.to));
    if (also.length) parts.push(el('span', { class: 'lab-warn', text: `It also plays at ${also.join(', ')}: the same music comes back there. Choose below whether it plays every time or the first time only.` }));
    if (learnt.moved) parts.push(el('span', { class: 'lab-warn', text: `Play at moved to ${fmt(marks.playAt)}: the drive can't recognise it any sooner.` }));
    message('ok', ...parts);
    quietLine();
  }

  // ---------------------------------------------------------------- the quietest room it still hears
  // How loud the music must be where the drive is, for the drive to recognise this moment: the song
  // turned down 2 dB at a time through the simulated mic of the bench Pulse (firmware R5c).
  const ROOM_DB = [['a home stereo', pulse.ROOMS.home.spl], ['a bar', pulse.ROOMS.bar.spl], ['a club', pulse.ROOMS.club.spl]];
  function quietLine() {
    const b = $('smQuiet');
    const q = learntOk() ? learnt.quiet : undefined;
    b.hidden = q === undefined;
    if (q === undefined) return b.replaceChildren();
    const head = el('strong', { text: 'Quietest room it still hears: ' });
    if (q === 'working') return b.replaceChildren(head, 'working it out… The drive hears the moment quieter and quieter, 8 times a level. About 10 seconds.');
    if (q.error) return b.replaceChildren(head, `couldn't work it out (${q.error}). Move the marks a little to try again.`);
    if (q.db === null) return b.replaceChildren(head, `louder than ${M.QUIET.loudest} dB. Even that loud the drive missed it more than half the time. Listen for longer, or move listening onto a part with more going on.`);
    const list = (rs) => rs.map(([n, db]) => `${n} (~${db} dB)`).join(', ').replace(/, ([^,]*)$/, ' and $1');
    const ok = ROOM_DB.filter(([, db]) => db >= q.db), not = ROOM_DB.filter(([, db]) => db < q.db);
    const rooms = !not.length ? `${list(ok)} ${ok.length > 1 ? 'are all' : 'is'} loud enough.`
      : !ok.length ? `Louder than ${list(not)}.`
      : `${list(ok)} ${ok.length > 1 ? 'are' : 'is'} loud enough; ${list(not)} ${not.length > 1 ? 'aren\'t' : 'isn\'t'}.`;
    b.replaceChildren(head, el('span', { class: 'sm-quiet-db', text: `${q.db} dB` }),
      q.phoneDb === null ? '' : ` (a phone's sound meter would show about ${q.phoneDb} dB(A) for this music)`,
      `. Quieter than that it mostly misses it. ${rooms[0].toUpperCase()}${rooms.slice(1)} `,
      el('span', { class: 'note', text: 'Simulated for the bench Pulse and the 2.1 demo, with the music measured where the drive is. Not bench-tested yet.' }));
  }
  function hearQuiet() {
    if (!learntOk() || learnt.quiet !== undefined) return;
    const l = learnt, near = Math.max(0, marks.from - 12), m = { from: marks.from - near, to: marks.to - near };
    l.quiet = 'working';
    const audio = song.audio.slice(Math.floor(near * RATE), Math.floor(Math.min(song.duration, marks.to + 3) * RATE));
    const done = (q) => { l.quiet = q; if (learnt === l) quietLine(); };
    quietDone = work('quiet', { audio, print: l.print, marks: m }).then(done, (e) => done({ error: e.message }));
    quietLine();
  }
  let quietDone = Promise.resolve();

  // ---------------------------------------------------------------- songs
  let actx = null;
  async function decode(bytes) {
    actx = actx || new AudioContext();
    const buffer = await actx.decodeAudioData(bytes.slice(0));
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * RATE)), RATE);
    const s = off.createBufferSource();
    s.buffer = buffer; s.connect(off.destination); s.start();
    return { buffer, audio: (await off.startRendering()).getChannelData(0) };
  }
  // Opens a clip. `at`: a saved moment to show, else the first guess at the drop.
  async function openSong(name, bytes, inLibrary, at = null) {
    stop();
    message('', `Reading ${name}…`);
    const { buffer, audio } = await decode(bytes);
    song = { name, audio, buffer, duration: buffer.duration, inLibrary, bytes: inLibrary ? null : bytes, peaks: null };
    learnt = null; checked = null; pv = null;
    await work('clip', { clip: name, audio });
    const found = await work('grid', { clip: name });
    if (at) {
      grid = { bpm: at.bpm, firstBar: at.firstBar };
      bars = Math.round((at.listenTo - at.listenFrom) / beat() / 4) || M.LISTEN_BARS.start;
      marks = { from: at.listenFrom, to: at.listenTo, playAt: at.playAt };
      learnt = { key: keyOf(), ok: true, print: at.print, kept: at.kept, bytes: at.print.length / 2, heard: at.heard ?? M.HEARINGS.length, hearings: M.HEARINGS.length, recognisedAt: at.recognisedAt ?? at.listenTo, alsoHeardAt: at.alsoHeardAt || [] };
      if (Number.isFinite(at.quietDb)) learnt.quiet = { db: at.quietDb, phoneDb: at.quietPhoneDb ?? null };
      checked = at.checkedAgainst && at.checkedAgainst.length ? { key: keyOf(), passed: at.checkedAgainst, fired: [] } : null;
    } else {
      grid = found.grid;
      placeAt(found.drop ?? Math.min(song.duration - 8, Math.max(20, song.duration * 0.4)), false);
    }
    fields();
    centre();
    changed();
    if (!at) $('smName').value = `${name.replace(/\.[^.]+$/, '')} ${fmt(marks.playAt)}`;
  }
  async function songList(pick) {
    const lib = state.library, sel = $('smSong');
    const names = lib ? await lib.songs().catch(() => []) : [];
    sel.replaceChildren(el('option', { value: '', text: lib ? (names.length ? 'Choose a song' : 'No songs in the library yet') : 'Choose a library folder to keep songs' }));
    names.forEach((n) => sel.append(el('option', { value: n, text: n })));
    if (song && !names.includes(song.name)) sel.append(el('option', { value: song.name, text: `${song.name} (not in the library yet)` }));
    sel.value = pick ?? (song ? song.name : '');
    const saved = lib ? await lib.moments().catch(() => []) : [];
    const ms = $('smSaved');
    ms.replaceChildren(el('option', { value: '', text: saved.length ? 'Choose a song moment' : 'None saved yet' }));
    saved.forEach((m, i) => ms.append(el('option', { value: String(i), text: `${m.name} (${m.song})` })));
    ms._saved = saved;
    ms.disabled = $('smOpenBtn').disabled = !saved.length;
  }

  // ---------------------------------------------------------------- the marks
  function placeAt(t, learn = true) {
    const playAt = M.snap(grid, t);
    marks = M.fitMarks(grid, song.duration, { ...M.listenFor(grid, playAt, bars), playAt });
    if (learn) { centre(); changed(); }
  }
  // Play at, kept on a beat and after the drive can recognise the moment
  function earliest() { return M.earliestPlay(grid, learntOk() ? learnt.recognisedAt : marks.to - M.MARGIN); }
  function setPlay(t) { marks.playAt = Math.min(Math.max(M.snap(grid, t), earliest()), song.duration); pv = null; }
  function setListenEnd(to) {
    const len = bars * 4 * beat();
    marks = M.fitMarks(grid, song.duration, { from: to - len, to, playAt: marks.playAt });
  }
  function centre() {
    const w = $('smDetail').clientWidth || 900, shown = Math.max(7, Math.min(15, Math.round(w / 60)));  // bars: fewer on a phone
    const span = Math.min(song.duration, shown * 4 * beat());
    let from = marks.from - (shown >= 12 ? 3 : 1) * 4 * beat();
    from = Math.max(0, Math.min(from, song.duration - span));
    view = { from, to: from + span };
  }
  let learnTimer = null;
  function changed() {
    pv = null;
    if (song && marks && !learntNow()) {
      clearTimeout(learnTimer);
      learnTimer = setTimeout(learn, 300);
    }
    fields(); status(); drawAll();
  }
  let learning = '';   // the marks being learnt now
  function learn() {
    const key = keyOf();
    if (!key || learntNow() || learning === key) return;
    const m = { from: marks.from, to: marks.to };
    learning = key;
    pending = work('learn', { clip: song.name, marks: m }).then((r) => {
      if (learning === key) learning = '';
      if (keyOf() !== key) return;          // the marks moved on: a newer one is learning
      learnt = { key, ...r };
      if (r.ok) {
        const before = marks.playAt;
        marks = M.fitMarks(grid, song.duration, marks, r.recognisedAt);
        learnt.moved = marks.playAt > before + 1e-6;
      }
      pv = null; fields(); status(); drawAll();
      hearQuiet();
    }).catch((e) => { if (learning === key) learning = ''; if (keyOf() === key) { learnt = { key, ok: false, problem: `Something went wrong learning it (${e.message}). Move the marks a little to try again.` }; status(); } });
  }

  function fields() {
    const has = !!(song && grid);
    for (const id of ['smBars', 'smBpm', 'smBar1', 'smBarShift', 'smPlayBack', 'smPlayOn', 'smListenBack', 'smListenOn', 'smPlay', 'smRestart']) $(id).disabled = !has;
    $('smSave').disabled = !(has && learntOk());
    $('smCheck').disabled = !(has && learntOk() && state.library);
    if (!has) { $('smPlayAt').textContent = '–'; $('smListenText').textContent = '–'; return; }
    const sel = $('smBars'), choices = M.listenChoices(grid);
    if (!choices.includes(bars)) bars = choices.includes(M.LISTEN_BARS.start) ? M.LISTEN_BARS.start : choices[choices.length - 1];
    sel.replaceChildren(...choices.map((b) => el('option', { value: String(b), text: `${b} bars (${(b * 4 * beat()).toFixed(1)} s)` })));
    sel.value = String(bars);
    if (document.activeElement !== $('smBpm')) $('smBpm').value = String(grid.bpm);
    if (document.activeElement !== $('smBar1')) $('smBar1').value = grid.firstBar.toFixed(3);
    $('smPlayAt').textContent = `${fmt(marks.playAt)}, ${M.barBeat(grid, marks.playAt)}`;
    $('smListenText').textContent = `${fmt(marks.from)} to ${fmt(marks.to)}`;
    $('smRepeatNote').textContent = learntOk() && learnt.alsoHeardAt.length ? `This clip has the moment ${learnt.alsoHeardAt.length + 1} times.` : 'In this clip the drive hears it once.';
  }

  // ---------------------------------------------------------------- drawing the song
  const C = { wave: '#7d726a', beat: 'rgba(241,234,227,0.10)', bar: 'rgba(241,234,227,0.32)', text: '#b5a99f', resin: '#ff8a2a', band: 'rgba(255,138,42,0.16)', paper: '#f1eae3' };
  function sized(cv) {
    const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    return { g, w, h, dpr };
  }
  function wave(g, from, to, w, h, top, height) {
    const a = song.audio, per = (to - from) * RATE / w;
    g.fillStyle = C.wave;
    for (let x = 0; x < w; x++) {
      const i0 = Math.max(0, Math.floor(from * RATE + x * per)), i1 = Math.min(a.length, Math.floor(from * RATE + (x + 1) * per));
      let lo = 0, hi = 0;
      for (let i = i0, step = Math.max(1, Math.floor((i1 - i0) / 400)); i < i1; i += step) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const mid = top + height / 2;
      g.fillRect(x, mid - hi * height / 2, 1, Math.max(1, (hi - lo) * height / 2));
    }
  }
  function drawOverview() {
    const cv = $('smOverview');
    if (!cv.clientWidth) return;
    const { g, w, h, dpr } = sized(cv);
    if (!song) return;
    const X = (t) => (t / song.duration) * w;
    if (!song.peaks || song.peaks.w !== w) {    // the whole song is a lot of samples: keep its picture
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      wave(off.getContext('2d'), 0, song.duration, w, h, 2 * dpr, h - 4 * dpr);
      song.peaks = { w, img: off };
    }
    g.drawImage(song.peaks.img, 0, 0);
    g.fillStyle = C.band; g.fillRect(X(marks.from), 0, Math.max(2, X(marks.to) - X(marks.from)), h);
    g.fillStyle = C.resin; g.fillRect(X(marks.playAt) - dpr, 0, 2 * dpr, h);
    if (learntOk()) for (const t of learnt.alsoHeardAt) { const x = X(t + marks.playAt - marks.to); g.fillRect(x - dpr, 0, 2 * dpr, h); g.beginPath(); g.moveTo(x - 5 * dpr, 0); g.lineTo(x + 5 * dpr, 0); g.lineTo(x, 7 * dpr); g.fill(); }
    g.strokeStyle = C.paper; g.lineWidth = dpr;
    g.strokeRect(X(view.from) + dpr / 2, dpr / 2, X(view.to) - X(view.from) - dpr, h - dpr);
  }
  function drawDetail() {
    const cv = $('smDetail');
    if (!cv.clientWidth) return;
    const { g, w, h, dpr } = sized(cv);
    if (!song) {
      g.fillStyle = C.text; g.font = `${14 * dpr}px Barlow, system-ui, sans-serif`;
      g.fillText('The song\'s waveform shows here, with its beats and bars.', 12 * dpr, h / 2);
      return;
    }
    const X = (t) => ((t - view.from) / (view.to - view.from)) * w, ruler = 20 * dpr, foot = 20 * dpr;
    g.font = `${12 * dpr}px Barlow, system-ui, sans-serif`; g.textBaseline = 'middle';
    // listening
    const bx = X(marks.from), bw = X(marks.to) - bx;
    g.fillStyle = C.band; g.fillRect(bx, ruler, bw, h - ruler - foot);
    g.fillStyle = C.resin; g.fillRect(bx, ruler, bw, 3 * dpr);
    // the music
    wave(g, view.from, view.to, w, h, ruler, h - ruler - foot);
    // beats and bars
    for (let k = Math.ceil(M.beatOf(grid, view.from)); k <= M.beatOf(grid, view.to); k++) {
      const x = Math.round(X(M.beatTime(grid, k))), isBar = ((k % 4) + 4) % 4 === 0;
      g.fillStyle = isBar ? C.bar : C.beat;
      g.fillRect(x, isBar ? ruler - 6 * dpr : ruler, dpr, h - ruler - foot + (isBar ? 6 * dpr : 0));
      if (isBar) { g.fillStyle = C.text; g.fillText(String(k / 4 + 1), x + 3 * dpr, ruler / 2); }
    }
    g.fillStyle = C.paper;
    if (bw > 120 * dpr) g.fillText(`Listen for ${bars} bars`, bx + 6 * dpr, ruler + 14 * dpr);
    // recognised by here (dashed), Play at (solid)
    const rec = learntOk() ? learnt.recognisedAt : marks.to, rx = X(rec);
    g.strokeStyle = C.paper; g.lineWidth = dpr; g.setLineDash([4 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(rx, ruler); g.lineTo(rx, h - foot + 4 * dpr); g.stroke(); g.setLineDash([]);
    g.textAlign = 'right'; g.fillStyle = C.text;
    g.fillText(learntOk() ? 'recognised by here' : 'recognised by about here', rx - 4 * dpr, h - foot / 2);
    g.textAlign = 'left';
    const px = X(marks.playAt);
    g.fillStyle = C.resin; g.fillRect(px - dpr, ruler - 6 * dpr, 2 * dpr, h - ruler - foot + 6 * dpr);
    g.beginPath(); g.moveTo(px - 6 * dpr, ruler - 8 * dpr); g.lineTo(px + 6 * dpr, ruler - 8 * dpr); g.lineTo(px, ruler); g.fill();
    g.fillText(`Play at ${fmt(marks.playAt)}`, px + 8 * dpr, h - foot / 2);
    // where the preview is
    if (pt >= view.from && pt <= view.to && (playing || pt > 0)) { g.fillStyle = C.paper; g.fillRect(X(pt) - dpr, 0, 2 * dpr, h); }
  }
  function drawAll() { drawOverview(); drawDetail(); drawDrive(); }

  // ---------------------------------------------------------------- dragging
  let drag = null;
  const tAt = (cv, e, v) => v.from + (e.offsetX / cv.clientWidth) * (v.to - v.from);
  $('smDetail').addEventListener('pointerdown', (e) => {
    if (!song) return;
    const cv = $('smDetail'), t = tAt(cv, e, view), px = (marks.playAt - view.from) / (view.to - view.from) * cv.clientWidth;
    if (Math.abs(e.offsetX - px) <= 10) drag = { kind: 'play' };
    else if (t >= marks.from && t <= marks.to) drag = { kind: 'listen', grab: marks.to - t };
    else drag = { kind: 'click', x: e.offsetX };
    cv.setPointerCapture(e.pointerId);
  });
  $('smDetail').addEventListener('pointermove', (e) => {
    const cv = $('smDetail');
    if (!song) return;
    const t = tAt(cv, e, view);
    if (!drag) {
      const px = (marks.playAt - view.from) / (view.to - view.from) * cv.clientWidth;
      cv.style.cursor = Math.abs(e.offsetX - px) <= 10 || (t >= marks.from && t <= marks.to) ? 'ew-resize' : 'pointer';
      return;
    }
    if (drag.kind === 'play') setPlay(t);
    else if (drag.kind === 'listen') { setListenEnd(M.snap(grid, t + drag.grab, 0.25)); marks.playAt = Math.max(marks.playAt, M.earliestPlay(grid, marks.to - M.MARGIN)); drag.moved = true; }
    else return;
    fields(); drawAll();
  });
  $('smDetail').addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'click' && Math.abs(e.offsetX - d.x) < 5) placeAt(tAt($('smDetail'), e, view));
    else changed();
  });
  $('smOverview').addEventListener('pointerdown', (e) => {
    if (!song) return;
    const cv = $('smOverview'), move = (ev) => {
      const span = view.to - view.from, t = (ev.offsetX / cv.clientWidth) * song.duration;
      const from = Math.max(0, Math.min(song.duration - span, t - span / 2));
      view = { from, to: from + span };
      drawOverview(); drawDetail();
    };
    move(e);
    cv.setPointerCapture(e.pointerId);
    cv.onpointermove = move;
    cv.onpointerup = () => { cv.onpointermove = null; };
  });

  // ---------------------------------------------------------------- the preview
  function animations() { return $('smAnim')._list || [dropExample()]; }
  function chosen() { const list = animations(); return list.find((a) => a.name === $('smAnim').value) || list[0]; }
  function colours() {
    const set = ($('smColours')._sets || []).find((p) => p.name === $('smColours').value);
    return set ? set.colours : tab.settings('pulse');
  }
  // The song around the moment, heard through the simulated mic in the chosen room: today's beat
  // look from the engine, and where this drive recognises the moment and plays the animation.
  function preview() {
    if (pv || !song || !marks) return pv;
    const anim = normalise(chosen()), len = length(anim) || 0;
    const from = Math.max(0, marks.from - 4 * beat());
    const guessEnd = marks.playAt + (anim.timing === 'ms' ? len / 1000 : len * beat());
    const to = Math.min(song.duration, guessEnd + 8 * beat());
    const segFrom = Math.max(0, from - LEAD), seg = song.audio.subarray(Math.floor(segFrom * RATE), Math.floor(to * RATE));
    const st = pulse.stage1(pulse.micVolts(seg, RATE, $('smRoom').value, PREROLL, 7), RATE);
    const S = tab.settings('pulse'), run = pulse.stage2(st, S), base = pulseMusic(run, st);
    const plugMs = (c) => (c - segFrom + PREROLL) * 1000;
    const out = { from, to, segFrom, st, run, plugMs, fire: null, start: null, end: null, show: null, anim };
    if (learntOk()) {
      const own = listen([M.momentPrint(learnt)], st, PREROLL).map((f) => f.t + segFrom).find((t) => Math.abs(t - marks.to) < 0.5);
      if (own !== undefined) {
        out.fire = own;
        out.start = own + (marks.playAt - marks.to);
        const shift = plugMs(out.start) - run.startMs;
        // a moment that plays over the normal look (R9) has today's ambient under it, from when it started
        const under = anim.over ? pulseAmbient(S) : null, underFrom = run.phaseEnds[6] - shift;
        out.show = new Show({ sections: [anim], under, underFrom, drive: makeDrive(tab.profile()), colours: colours(), brightness: S.brightness, music: (ms) => base(ms + shift) });
        if (anim.timing === 'ms') out.end = out.start + len / 1000;
        else {
          const b0 = base(shift).beats;
          let ms = 0;
          while (out.start + ms / 1000 < to && base(ms + shift).beats - b0 < len * BEAT) ms += 10;
          out.end = out.start + ms / 1000;
        }
      }
    }
    pv = out;
    previewNote();
    return pv;
  }
  function previewNote() {
    const room = $('smRoom').selectedOptions[0].textContent.toLowerCase(), a = chosen();
    let note;
    if (!song) note = '';
    else if (!learntNow()) note = 'The preview shows the beat look until the drive has learnt the moment.';
    else if (!learnt.ok) note = 'The preview shows the beat look only: the drive can\'t recognise this moment yet.';
    else if (!pv || pv.fire === null) note = `In the simulated ${room} the drive didn't recognise it this time, so it keeps its beat look. Try another room, or listen for longer.`;
    else note = `In the simulated ${room} the drive recognised it at ${fmt(pv.fire)} and plays "${a.name}" at ${fmt(pv.start)} (Play at ${fmt(marks.playAt)}). Before and after: today's beat look.`;
    $('smPvNote').textContent = note;
  }
  const DARK = () => Array.from({ length: 8 }, () => [0, 0, 0]);
  function frameAt(c) {
    const p = preview();
    if (!p) return DARK();
    try {
      if (p.show && c >= p.start && c < p.end) return p.show.frame(Math.round((c - p.start) * 1000));
      const n = p.st.n, i = Math.min(n - 1, Math.max(0, Math.round((p.plugMs(c) - p.run.startMs) / pulse.BLOCK_MS) - 1));
      return Array.from({ length: 8 }, (_, k) => [...p.run.leds.subarray(i * 24 + k * 3, i * 24 + k * 3 + 3)]);
    } catch { return DARK(); }
  }
  function drawDrive() {
    if (tab.family() !== 'pulse') return;
    const p = song ? preview() : null;
    if (p && (pt < p.from || pt > p.to)) pt = p.from;
    tab.light(lens, p ? frameAt(pt) : DARK());
    let clock = '';
    if (p) {
      clock = `${fmt(pt)} · ${M.barBeat(grid, pt).replace(/\.\d+$/, '')}`;
      if (p.show && pt >= p.start && pt < p.end) clock += `\nplaying ${p.anim.name}`;
      else if (pt >= marks.from && pt < (p.fire ?? marks.to)) clock += '\nlistening';
      else if (p.fire !== null && pt >= p.fire && pt < p.start) clock += '\nrecognised';
      else clock += '\nbeat look';
    }
    $('smClock').textContent = clock;
    $('smClock').style.whiteSpace = 'pre-line';
    $('smScrub').value = p ? String(Math.round(((pt - p.from) / (p.to - p.from)) * 1000)) : '0';
  }

  // ---------------------------------------------------------------- sound
  let src = null, srcAt = 0, srcT0 = 0;
  function stopSound() { if (!src) return; try { src.stop(); } catch {} src.disconnect(); src = null; }
  function syncSound() {
    stopSound();
    if (!playing || !song || !$('smSound').checked || $('p-routines').hidden) return;
    try {
      actx = actx || new AudioContext();
      if (actx.state === 'suspended') actx.resume();
      src = actx.createBufferSource();
      src.buffer = song.buffer; src.connect(actx.destination); src.start(0, pt);
      srcAt = actx.currentTime; srcT0 = pt;
    } catch (e) { $('smPvNote').textContent = `Can't play the sound here: ${e.message}`; }
  }
  function stop() { playing = false; $('smPlay').textContent = 'Play'; stopSound(); }

  // ---------------------------------------------------------------- the lists
  async function reload() {
    const lib = state.library, pulseOnly = tab.family() === 'pulse';
    $('smBody').hidden = !pulseOnly;
    $('smCoreNote').hidden = pulseOnly;
    if (!pulseOnly) { stop(); return; }
    tab.buildBoard($('smBoard'), lens);
    const saved = lib ? await lib.animations('pulse').catch(() => []) : [];
    const list = [dropExample(), ...saved.filter((a) => a.once)];
    const sel = $('smAnim'), keep = sel.value;
    sel.replaceChildren(...list.map((a, i) => el('option', { value: a.name, text: i ? a.name : `${a.name}, built in` })));
    sel._list = list;
    sel.value = list.some((a) => a.name === keep) ? keep : list[0].name;
    $('smAnimNote').textContent = saved.some((a) => a.once) ? '' : 'Save one-shot animations (Pulse) in the Animation lab above and they show here too.';
    const pal = $('smColours'), keepPal = pal.value;
    const sets = lib ? await lib.palettes('pulse').catch(() => []) : [];
    pal.replaceChildren(el('option', { value: '', text: 'Colours in Tune it' }), ...sets.map((p) => el('option', { value: p.name, text: p.name })));
    pal._sets = sets;
    pal.value = sets.some((p) => p.name === keepPal) ? keepPal : '';
    await songList();
    pv = null;
    fields(); status(); drawAll(); previewNote();
  }

  // ---------------------------------------------------------------- controls
  $('smFile').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      if (!M.AUDIO_TYPES.test(file.name)) throw new Error(`${file.name} isn't a sound file the app knows. Use an .mp3, .wav, .m4a, .aiff, .flac or .ogg file.`);
      const bytes = await file.arrayBuffer();
      let kept = false;
      if (state.library) { await state.library.addSong(file.name, bytes); kept = true; }
      pending = openSong(file.name, bytes, kept);
      await pending;
      await songList(file.name);
      $('smSongNote').textContent = kept
        ? `${file.name} is in the library's songs folder${state.library.saved ? '' : ' (demo library: lost when you close the page)'}. It stays on this computer.`
        : `${file.name} is open, but not kept: choose a library folder (Library tab) and it's copied into its songs folder when you save.`;
    } catch (e) { song = null; message('bad', el('strong', { text: `Couldn't open ${file.name}. ` }), `${e.message || 'Unknown format.'} Try an .mp3 or .wav file.`); drawAll(); fields(); }
  });
  $('smSong').addEventListener('change', async () => {
    const name = $('smSong').value;
    if (!name || (song && song.name === name)) return;
    try { pending = openSong(name, await state.library.readSong(name), true); await pending; $('smSongNote').textContent = `${name}, from the library's songs folder.`; } catch (e) { message('bad', `Couldn't open ${name}: ${e.message}`); }
  });
  $('smOpenBtn').addEventListener('click', async () => {
    const m = ($('smSaved')._saved || [])[Number($('smSaved').value)];
    if (!m || $('smSaved').value === '') return saveMsg('Choose a song moment in the list first.');
    try {
      const bytes = await state.library.readSong(m.song).catch(() => { throw new Error(`its song ${m.song} isn't in the library's songs folder. Add the clip again with the same name.`); });
      pending = openSong(m.song, bytes, true, m);
      await pending;
      $('smName').value = m.name;
      if ((animations()).some((a) => a.name === m.animation)) $('smAnim').value = m.animation;
      else saveMsg(`Its animation "${m.animation}" isn't in the library: showing "${chosen().name}" instead.`);
      document.querySelector(`input[name="smRepeat"][value="${m.repeat}"]`).checked = true;
      await songList(m.song);
      pv = null; drawAll(); previewNote();
    } catch (e) { saveMsg(`Can't open "${m.name}": ${e.message}`); }
  });
  $('smBars').addEventListener('change', () => {
    bars = Number($('smBars').value);
    setListenEnd(marks.to);
    marks.playAt = Math.max(marks.playAt, M.earliestPlay(grid, marks.to - M.MARGIN));
    changed();
  });
  const nudge = (id, fn) => $(id).addEventListener('click', () => { if (song) { fn(); changed(); } });
  nudge('smPlayBack', () => setPlay(marks.playAt - beat()));
  nudge('smPlayOn', () => setPlay(marks.playAt + beat()));
  nudge('smListenBack', () => { setListenEnd(marks.to - beat()); });
  nudge('smListenOn', () => { setListenEnd(marks.to + beat()); marks.playAt = Math.max(marks.playAt, M.earliestPlay(grid, marks.to - M.MARGIN)); });
  function newGrid(g) {
    if (!(g.bpm >= 60 && g.bpm <= 220) || !Number.isFinite(g.firstBar)) { message('bad', 'BPM goes from 60 to 220, and bar 1 is a time in seconds.'); return; }
    grid = { bpm: Math.round(g.bpm * 100) / 100, firstBar: ((g.firstBar % (4 * 60 / g.bpm)) + 4 * 60 / g.bpm) % (4 * 60 / g.bpm) };
    marks.playAt = M.snap(grid, marks.playAt);
    marks = M.fitMarks(grid, song.duration, marks, learntOk() ? learnt.recognisedAt : marks.to);
    changed();
  }
  $('smBpm').addEventListener('change', () => newGrid({ bpm: Number($('smBpm').value), firstBar: grid.firstBar }));
  $('smBar1').addEventListener('change', () => newGrid({ bpm: grid.bpm, firstBar: Number($('smBar1').value) }));
  $('smBarShift').addEventListener('click', () => newGrid({ bpm: grid.bpm, firstBar: grid.firstBar + beat() }));
  for (const id of ['smAnim', 'smColours', 'smRoom']) $(id).addEventListener('change', () => { pv = null; drawDrive(); previewNote(); });
  $('smPlay').addEventListener('click', () => { playing = !playing; $('smPlay').textContent = playing ? 'Pause' : 'Play'; last = null; syncSound(); });
  $('smRestart').addEventListener('click', () => { const p = preview(); if (p) pt = p.from; last = null; drawAll(); syncSound(); });
  $('smScrub').addEventListener('input', () => { const p = preview(); if (!p) return; pt = p.from + (Number($('smScrub').value) / 1000) * (p.to - p.from); last = null; drawAll(); syncSound(); });
  $('smSound').addEventListener('change', syncSound);

  $('smSave').addEventListener('click', async () => {
    if (!state.library) return saveMsg('Choose a library folder first (Library tab, Choose library folder). Song moments are kept in its moments folder and the song in its songs folder.');
    if (!learntOk()) return saveMsg('Wait until the drive has learnt the moment (the message above says "Learnt").');
    try {
      if (!song.inLibrary) { await state.library.addSong(song.name, song.bytes); song.inLibrary = true; song.bytes = null; }
      const repeat = document.querySelector('input[name="smRepeat"]:checked').value;
      const moment = M.makeMoment({
        name: $('smName').value, song: song.name, ...grid, listenFrom: marks.from, listenTo: marks.to, playAt: marks.playAt,
        animation: chosen().name, repeat, print: learnt.print, kept: learnt.kept, heard: learnt.heard, recognisedAt: learnt.recognisedAt, alsoHeardAt: learnt.alsoHeardAt,
        quietDb: learnt.quiet && learnt.quiet.db, quietPhoneDb: learnt.quiet && learnt.quiet.phoneDb,
        checkedAgainst: checked && checked.key === keyOf() ? checked.passed : [],
      });
      const { file, replaced } = await state.library.saveMoment(moment);
      await songList(song.name);
      saveMsg(`Saved "${moment.name}" as moments/${file}${replaced ? ', replacing the one saved before' : ''}${state.library.saved ? '' : ' (demo library: lost when you close the page)'}. The drive waits ${moment.delayMs} ms (${moment.delayBeats} beats) after recognising it, then plays "${moment.animation}".`);
    } catch (e) { saveMsg(e.message); }
  });
  $('smCheck').addEventListener('click', async () => {
    if (!learntOk() || !state.library) return;
    const key = keyOf(), moment = { print: learnt.print }, passed = [], fired = [];
    $('smCheck').disabled = true;
    try {
      const others = (await state.library.songs()).filter((n) => n !== song.name);
      for (const name of others) {
        saveMsg(`Listening to ${name}…`);
        const { audio } = await decode(await state.library.readSong(name));
        const at = await work('check', { moment, audio });
        if (at.length) fired.push({ name, at }); else passed.push(name);
      }
      saveMsg('Listening to the demo track…');
      const demo = await work('check', { moment, audio: pulse.synthDnb(RATE, { bars: 46 }).audio });
      if (demo.length) fired.push({ name: 'the demo track', at: demo }); else passed.push('the demo track');
      checked = { key, passed, fired };
      const n = others.length;
      saveMsg(fired.length
        ? `It fired on ${fired.map((f) => `${f.name} at ${f.at.map(fmt).join(', ')}`).join('; ')}. Listen for longer, or move listening onto a part only this song has.`
        : `Checked against ${n ? `${n} other song${n === 1 ? '' : 's'} in the library and ` : ''}the demo track, in a simulated club: it never fired.${n ? '' : ' Add more songs to the library to check against them.'}`);
    } catch (e) { saveMsg(`Couldn't finish checking: ${e.message}`); }
    fields();
  });

  function tick(now) {
    const visible = !$('p-routines').hidden && tab.family() === 'pulse';
    if (playing && visible && song) {
      const p = preview();
      if (src) pt = srcT0 + (actx.currentTime - srcAt);
      else if (last !== null) pt += (now - last) / 1000;
      last = now;
      if (p && pt >= p.to) { pt = p.from; syncSound(); }
      drawDrive(); drawDetail();
    } else last = null;
    if (!visible && src) stopSound();
    requestAnimationFrame(tick);
  }

  // For headless checks: open a clip, wait for learning, stop the clock at a time.
  window.synaptoMoments = {
    open: (name, bytes) => (pending = openSong(name, bytes, false)),
    settled: async () => { await pending; while (song && marks && !learntNow()) { learn(); await pending; await new Promise((r) => setTimeout(r, 50)); } },
    quiet: async () => { while (learntOk() && learnt.quiet === 'working') await quietDone; return learntOk() ? learnt.quiet : null; },
    at(t) { stop(); pt = t; drawAll(); },
    state: () => ({ grid, marks, view, learnt: learnt && { ok: learnt.ok, recognisedAt: learnt.recognisedAt, alsoHeardAt: learnt.alsoHeardAt, problem: learnt.problem }, preview: pv && { fire: pv.fire, start: pv.start, end: pv.end } }),
  };

  requestAnimationFrame(tick);
  fields(); status(); drawAll();
  return {
    reload: () => reload().catch(() => {}),
    redraw: () => { pv = null; drawAll(); },
    // for Light cues (js/cues-tab.js): the open song, its beats and Play at
    // (and the clip as the mic model hears it, and the room the preview is in)
    current: () => (song && grid ? { name: song.name, buffer: song.buffer, audio: song.audio, rate: RATE, duration: song.duration, grid: { ...grid }, playAt: marks ? marks.playAt : null, room: $('smRoom').value, roomName: $('smRoom').selectedOptions[0].textContent.toLowerCase() } : null),
    // pick a saved animation for the moment (after Light cues saves one)
    useAnimation: (name) => reload().then(() => { if (animations().some((a) => a.name === name)) { $('smAnim').value = name; pv = null; drawDrive(); previewNote(); } }).catch(() => {}),
  };
}
