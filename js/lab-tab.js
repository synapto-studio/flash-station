// The Animation lab in the Routines tab (roadmap R3): paste a recipe Claude wrote, pick a colour
// set, watch it on the drive drawing (a beat-timed one with a steady beat, the demo track or a
// song clip, heard through the Pulse's simulated mic as today's engine hears it), then save it
// to the library's animations/ folder. Reading and checking the recipe is js/lab.js, playing it
// js/player.js. tools/animation-clip.mjs drives this lab to make preview clips in a session.

import * as pulse from './preview-pulse.js';
import { Show, makeDrive, length, normalise } from './player.js';
import { readRecipe, describe, timelineLength, recipeText, MAX_TIMELINE_MS, LabError, RecipeError } from './lab.js';
import { coreEngine, coreDrift, pulseStartup, pulseAmbient, heartbeat, dropExample, pulseMusic } from './animations.js';
import { drawnLeds } from './profiles.js';

const RATE = 8000;  // the mic model's sample rate (as the Routines tab's demo)
const PREROLL = 1;  // s of room before the music (the drive is plugged in at 0)
const LEAD = 12;    // s of music before "Start at", for the beat detector to lock on
const BEAT = 16384; // one beat in the player's beat clock (1/65536 of a bar)
const STORE_KEY = 'synapto-lab-recipe';
const BOARD = { core: 'Core', pulse: 'Pulse' };

export function initAnimationLab({ $, el, state, tab }) {
  // tab: { family(), setFamily(f), settings(f), profile(), buildBoard(box, lensEls), stripOn(cv, len, frameFn, rows), light(lensEls, px) }
  let read = null;         // the recipe in the box: { recipe, anim, bytes, warnings }, or null
  let show = null, then = null, spanMs = 0, rows = [];
  let t = 0, playing = true, speed = 1, last = null;
  let lastText = null, lastName = null;
  const lens = [];

  // ---------------------------------------------------------------- what the recipe follows
  // Steady: bars at the BPM from the start. Demo or clip: the music heard through the Pulse's
  // simulated mic and beat detector (js/preview-pulse.js), from "Start at".
  let demo = null;         // the demo track, 8 kHz
  let clip = null;         // { name, audio (8 kHz mono), buffer (AudioBuffer to play), duration }
  let heard = { key: null };
  let pending = Promise.resolve();
  const startAt = () => Math.max(0, Number($('labStart').value) || 0);
  const bpm = () => Math.min(200, Math.max(60, Number($('labBpm').value) || 174));
  const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  function needsMusic() {
    return !!read && (read.anim.timing === 'beats' || (then && then.timing === 'beats'));
  }
  function musicSource() {
    const kind = $('labMusic').value;
    if (kind === 'steady' || (kind === 'clip' && !clip)) return { kind: 'steady', music: null, bpm: bpm(), until: Infinity };
    const audio = kind === 'demo' ? (demo || (demo = pulse.synthDnb(RATE, { bars: 46 }).audio)) : clip.audio;
    const room = $('labRoom').value, from0 = startAt();
    const key = [kind, kind === 'clip' ? clip.name + clip.duration : '', from0, room].join('|');
    if (heard.key !== key) {
      const total = audio.length / RATE;
      if (from0 >= total - 1) throw new LabError(`"Start at" is past the end of the ${kind === 'demo' ? 'demo track' : 'clip'} (${fmtTime(total)}).`);
      const lead = Math.min(from0, LEAD), from = Math.floor((from0 - lead) * RATE);
      const to = Math.min(audio.length, Math.floor((from0 + MAX_TIMELINE_MS / 1000 + 1) * RATE));
      const st = pulse.stage1(pulse.micVolts(audio.subarray(from, to), RATE, room, PREROLL, 7), RATE);
      const run = pulse.stage2(st, pulse.DEFAULTS);
      const base = pulseMusic(run, st), shift = (lead + PREROLL) * 1000 - run.startMs;
      heard = { key, kind, music: (ms) => base(ms + shift), until: Math.floor((to - from) / RATE * 1000 - lead * 1000) };
    }
    return heard;
  }
  // A length in the recipe's units, as ms of the lab's timeline from `fromMs`.
  function toMs(units, timing, src, fromMs = 0) {
    if (timing === 'ms') return units;
    if (!src.music) return Math.round(units * 60000 / src.bpm);
    const target = src.music(fromMs).beats + units * BEAT;
    for (let ms = fromMs; ms < src.until; ms += 10) if (src.music(ms).beats >= target) return ms - fromMs;
    return src.until - fromMs;
  }

  // ---------------------------------------------------------------- the recipe in the box
  function message(kind, ...parts) {
    const box = $('labMsg');
    box.className = `lab-msg ${kind}`;
    box.replaceChildren(...parts);
  }
  function showError(e) {
    const plain = e instanceof LabError || e instanceof RecipeError;
    const parts = [el('strong', { text: plain ? 'Can\'t show this recipe. ' : 'Something went wrong showing this recipe. ' }), e.message];
    if (e.at) {
      const go = el('button', { class: 'btn quiet', type: 'button', text: 'Show me where' });
      go.addEventListener('click', () => { const box = $('labText'); box.focus(); box.setSelectionRange(e.at.index, Math.min(box.value.length, e.at.index + 1)); });
      parts.push(' ', go);
    }
    parts.push(el('span', { class: 'lab-hint', text: 'Fix it in the box, or paste this message back to Claude for a corrected recipe.' }));
    message('bad', ...parts);
  }

  function readNow() {
    const text = $('labText').value;
    try { localStorage.setItem(STORE_KEY, text); } catch {}
    const changedText = text !== lastText;
    lastText = text;
    if (!text.trim()) {
      read = null;
      message('', 'Paste a recipe, or open one below to start from.');
      return refresh();
    }
    try {
      read = readRecipe(text);
    } catch (e) {
      read = null;
      showError(e);
      return refresh();
    }
    if (read.recipe.name && read.recipe.name !== lastName) $('labName').value = lastName = read.recipe.name;
    const b = read.anim.board;
    if (changedText && b !== 'any' && b !== tab.family()) return tab.setFamily(b); // the tab calls refresh()
    refresh();
  }
  let timer = null;
  function readSoon() { clearTimeout(timer); timer = setTimeout(readNow, 250); }

  // ---------------------------------------------------------------- the show
  let coloursFromTool = null; // tools/animation-clip.mjs --colours
  function colours() {
    const set = ($('labColours')._sets || []).find((p) => p.name === $('labColours').value);
    return coloursFromTool || (set ? set.colours : tab.settings(tab.family()));
  }
  function brightness() {
    const S = tab.settings(tab.family());
    return tab.family() === 'core' ? S.BRIGHTNESS : S.brightness;
  }
  function builtInLoop() {
    const f = tab.family(), S = tab.settings(f);
    return f === 'core' ? coreDrift(S) : pulseAmbient(S);
  }
  function thenAnim() {
    const v = $('labThen').value;
    if (!read || !read.anim.once || read.anim.timing !== 'ms' || !v) return null;
    const loop = v === 'builtin' ? builtInLoop() : ($('labThen')._saved || []).find((a) => a.name === v);
    return loop ? normalise(loop) : null;
  }

  // Everything that depends on the recipe, the board, its drawing, the colours or the music.
  function refresh() {
    const f = tab.family();
    tab.buildBoard($('labBoard'), lens);
    rows = drawnLeds(tab.profile()).map((q) => q.led - 1).reverse(); // top of the drive first
    show = null;
    then = null;
    const music = $('labMusicRow');
    if (read && read.anim.board !== 'any' && read.anim.board !== f) {
      message('bad', el('strong', { text: `This recipe is for ${BOARD[read.anim.board]}. ` }), `Choose ${BOARD[read.anim.board]} at the top of the tab to see it.`);
    } else if (read) {
      try {
        $('labThenWrap').hidden = !(read.anim.once && read.anim.timing === 'ms');
        then = thenAnim();
        music.hidden = !needsMusic();
        const steady = { music: null, bpm: bpm(), until: Infinity };
        let src = steady, musicError = null;
        if (needsMusic()) { try { src = musicSource(); } catch (e) { musicError = e.message; } }
        const sections = then ? [read.anim, then] : [read.anim];
        show = new Show({ sections, drive: makeDrive(tab.profile()), colours: colours(), brightness: brightness(), music: src.music, bpm: src.bpm });
        if (then) {
          const onceMs = length(read.anim);
          spanMs = onceMs + toMs(timelineLength(then), then.timing, src, onceMs);
        } else spanMs = toMs(timelineLength(read.anim), read.anim.timing, src);
        spanMs = Math.max(500, Math.min(spanMs, MAX_TIMELINE_MS, src.until));
        show.frame(0); // a recipe that can't play fails here, not in the drawing loop
        message('ok', el('strong', { text: 'This recipe works.' }),
          ...read.warnings.map((w) => el('span', { class: 'lab-warn', text: w })));
        $('labInfo').textContent = `${read.recipe.name || 'Untitled'}. ${describe(read.anim, read.bytes)}${then ? ` Then: ${then.name}.` : ''}`;
        musicNote(src, musicError);
      } catch (e) {
        show = null;
        showError(e);
      }
    }
    if (!read || (read.anim.board !== 'any' && read.anim.board !== f)) { music.hidden = true; $('labThenWrap').hidden = true; }
    if (!show) $('labInfo').textContent = '';
    $('labSave').disabled = !show;
    if (t > spanMs) t = 0;
    drawStrip();
    draw();
    syncSound();
  }

  function musicNote(src, error) {
    const kind = $('labMusic').value, room = $('labRoom').selectedOptions[0].textContent.toLowerCase();
    $('labBpmWrap').hidden = kind !== 'steady';
    $('labClipWrap').hidden = kind !== 'clip';
    $('labStartWrap').hidden = $('labRoomWrap').hidden = $('labSoundWrap').hidden = kind === 'steady';
    const kicks = read && read.anim.layers.some((l) => l.move === 'kick');
    let note;
    if (kind === 'steady') note = `A steady ${bpm()} BPM beat from the start, with no sound.${kicks ? ' Kicks only show with the demo track or a song clip.' : ''}`;
    else if (kind === 'demo') note = `The demo drum and bass track (174 BPM, drums from 0:01.7) from ${fmtTime(startAt())}, heard through the drive's simulated mic in a ${room}.`;
    else if (!clip) note = 'Choose a song clip (.mp3 or .wav). It stays on this computer. Until then the lab uses a steady beat.';
    else note = `${clip.name} from ${fmtTime(startAt())} (it's ${fmtTime(clip.duration)} long), heard through the drive's simulated mic in a ${room}. The clip stays on this computer.`;
    if (kind !== 'steady' && (kind === 'demo' || clip)) note += startAt() >= 4 ? ` The beat detector hears the ${Math.min(startAt(), LEAD).toFixed(0)} s before too, so it has found the beat, as it would have in the room.` : ' Start a few seconds in, so the beat detector has found the beat (it needs a bar or two).';
    if (src && src.until < MAX_TIMELINE_MS && src.until <= spanMs) note += ' The music ends before the timeline does.';
    if (error) note = `${error} Using a steady ${bpm()} BPM beat until that's fixed.`;
    $('labMusicNote').textContent = note;
    $('labMusicNote').classList.toggle('warn', !!error);
  }

  // ---------------------------------------------------------------- drawing
  const DARK = () => Array.from({ length: tab.family() === 'core' ? 6 : 8 }, () => [0, 0, 0]);
  function frame(ms) {
    if (!show) return DARK();
    try { return show.frame(Math.round(ms)); } catch { return DARK(); }
  }
  function drawStrip() {
    const cv = $('labStrip');
    if (!show || !cv.clientWidth) {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      $('labHead').hidden = true;
      return;
    }
    tab.stripOn(cv, spanMs, frame, rows);
  }
  function draw() {
    tab.light(lens, frame(t));
    $('labHead').hidden = !show;
    if (!show) { $('labClock').textContent = ''; return; }
    $('labHead').style.left = `${Math.min(100, (t / spanMs) * 100)}%`;
    let clock = `${(t / 1000).toFixed(2)} s`;
    if (needsMusic()) {
      const b = Math.max(0, (show.music(t).beats - show.music(0).beats) / BEAT);
      clock += ` · bar ${Math.floor(b / 4) + 1}, beat ${Math.floor(b % 4) + 1}`;
    }
    $('labClock').textContent = clock;
    $('labScrub').value = String(Math.round((t / spanMs) * 1000));
  }

  // ---------------------------------------------------------------- sound
  let audio = null, src = null, srcAt = 0, srcT0 = 0, demoBuffer = null;
  function trackBuffer() {
    const kind = $('labMusic').value;
    if (kind === 'clip') return clip && clip.buffer;
    if (kind !== 'demo' || !audio) return null;
    if (!demoBuffer) {
      demo = demo || pulse.synthDnb(RATE, { bars: 46 }).audio;
      demoBuffer = audio.createBuffer(1, demo.length, RATE);
      demoBuffer.copyToChannel(demo, 0);
    }
    return demoBuffer;
  }
  const soundWanted = () => playing && show && $('labSound').checked && needsMusic() && $('labMusic').value !== 'steady' && !$('p-routines').hidden;
  function stopSound() {
    if (!src) return;
    try { src.stop(); } catch {}
    src.disconnect();
    src = null;
  }
  function syncSound() {
    stopSound();
    if (!soundWanted()) return;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const buf = trackBuffer(), off = startAt() + t / 1000;
      if (!buf || off >= buf.duration) return;
      src = audio.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = speed;
      src.connect(audio.destination);
      src.start(0, off);
      srcAt = audio.currentTime; srcT0 = t;
    } catch (e) { $('labMusicNote').textContent = `Can't play the sound here: ${e.message}`; }
  }

  // ---------------------------------------------------------------- the lists
  function builtIns() {
    const f = tab.family(), S = tab.settings(f);
    const list = f === 'core' ? [coreEngine(S), coreDrift(S)] : [pulseStartup(S), pulseAmbient(S), dropExample()];
    return [...list, heartbeat()];
  }
  async function reload() {
    const lib = state.library, f = tab.family();
    const saved = lib ? await lib.animations(f).catch(() => []) : [];
    // open a recipe
    const open = $('labOpen');
    open.replaceChildren(el('option', { value: '', text: 'Choose a recipe' }));
    const g1 = el('optgroup', { label: 'Built in' });
    builtIns().forEach((r, i) => g1.append(el('option', { value: `b${i}`, text: r.name })));
    const g2 = el('optgroup', { label: lib ? (saved.length ? 'Saved in the library' : 'Saved: none yet') : 'Saved: choose a library folder' });
    saved.forEach((a, i) => g2.append(el('option', { value: `s${i}`, text: a.name })));
    open.append(g1, g2);
    open._saved = saved;
    // colours
    const pal = $('labColours'), keepPal = pal.value;
    pal.replaceChildren(el('option', { value: '', text: 'Colours in Tune it' }));
    const sets = lib ? await lib.palettes(f).catch(() => []) : [];
    sets.forEach((p) => pal.append(el('option', { value: p.name, text: p.name })));
    pal._sets = sets;
    pal.value = sets.some((p) => p.name === keepPal) ? keepPal : '';
    // what plays after a one-shot
    const th = $('labThen'), keepThen = th.value;
    th.replaceChildren(el('option', { value: '', text: 'Dark' }), el('option', { value: 'builtin', text: `${builtInLoop().name} (built in)` }));
    const loops = saved.filter((a) => !a.once);
    loops.forEach((a) => th.append(el('option', { value: a.name, text: a.name })));
    th._saved = loops;
    th.value = [...th.options].some((o) => o.value === keepThen) ? keepThen : '';
  }

  function saveMsg(text) { $('labSaveMsg').textContent = text; }

  // ---------------------------------------------------------------- controls
  $('labText').addEventListener('input', readSoon);
  $('labOpenBtn').addEventListener('click', () => {
    const v = $('labOpen').value;
    const r = v[0] === 'b' ? builtIns()[Number(v.slice(1))] : v[0] === 's' ? ($('labOpen')._saved || [])[Number(v.slice(1))] : null;
    if (!r) return message('', 'Choose a recipe in the list first.');
    $('labText').value = recipeText(r);
    lastName = null;
    t = 0;
    readNow();
    saveMsg('');
  });
  $('labPlay').addEventListener('click', () => {
    playing = !playing;
    $('labPlay').textContent = playing ? 'Pause' : 'Play';
    last = null;
    syncSound();
  });
  $('labRestart').addEventListener('click', () => { t = 0; last = null; draw(); syncSound(); });
  $('labSpeed').addEventListener('change', () => { speed = Number($('labSpeed').value); syncSound(); });
  $('labScrub').addEventListener('input', () => { t = (Number($('labScrub').value) / 1000) * spanMs; last = null; draw(); syncSound(); });
  for (const id of ['labColours', 'labThen', 'labMusic', 'labRoom']) $(id).addEventListener('change', refresh);
  for (const id of ['labBpm', 'labStart']) $(id).addEventListener('change', () => { t = 0; refresh(); });
  $('labSound').addEventListener('change', syncSound);
  $('labClip').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    $('labMusicNote').textContent = `Reading ${file.name}…`;
    pending = loadClip(file).then(() => { t = 0; refresh(); }).catch((e) => {
      clip = null;
      $('labMusicNote').textContent = `Couldn't read ${file.name} as music (${e.message || 'unknown format'}). Try an .mp3 or .wav file.`;
    });
  });
  async function loadClip(file) {
    const bytes = await file.arrayBuffer();
    audio = audio || new AudioContext();
    const buffer = await audio.decodeAudioData(bytes.slice(0));
    // the mic model's copy: mono at 8 kHz, resampled by the browser
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buffer.duration * RATE)), RATE);
    const s = off.createBufferSource();
    s.buffer = buffer;
    s.connect(off.destination);
    s.start();
    const mono = await off.startRendering();
    clip = { name: file.name, audio: mono.getChannelData(0), buffer, duration: buffer.duration };
    heard = { key: null };
  }
  $('labSave').addEventListener('click', async () => {
    if (!read) return saveMsg('Fix the recipe first: it has to show on the drive before it can be saved.');
    if (!state.library) return saveMsg('Choose a library folder first (Library tab, Choose library folder). Animations are kept in its animations folder.');
    try {
      const { animation, file, replaced } = await state.library.saveAnimation(read.recipe, $('labName').value);
      $('labText').value = recipeText(animation);
      lastName = animation.name;
      readNow();
      await reload();
      if (tab.saved) tab.saved(); // so Song moments lists it without leaving the tab
      saveMsg(`Saved "${animation.name}" as animations/${file}${replaced ? ', replacing the one saved before' : ''}${state.library.saved ? '' : ' (demo library: lost when you close the page)'}.`);
    } catch (e) { saveMsg(e.message); }
  });

  function tick(now) {
    const visible = !$('p-routines').hidden;
    if (playing && visible && show) {
      if (src) t = srcT0 + (audio.currentTime - srcAt) * 1000 * speed;
      else if (last !== null) t += (now - last) * speed;
      last = now;
      if (t >= spanMs) { t = 0; syncSound(); }
      draw();
    } else last = null;
    if (!visible && src) stopSound();
    if (visible && !src && soundWanted()) syncSound();
    requestAnimationFrame(tick);
  }

  // For tools/animation-clip.mjs: read the box now, wait for a clip, use its colours, and stop
  // the clock at a time.
  window.synaptoLab = {
    read: readNow,
    colours(set) { coloursFromTool = set; refresh(); },
    settled: () => pending,
    at(ms) { playing = false; $('labPlay').textContent = 'Play'; stopSound(); t = ms; draw(); },
    span: () => spanMs,
    ok: () => !!show,
    message: () => $('labMsg').textContent,
  };

  try { $('labText').value = localStorage.getItem(STORE_KEY) || ''; } catch {}
  requestAnimationFrame(tick);
  return {
    refresh() { if (read || lastText !== null) refresh(); },
    reload: () => reload().then(() => (lastText === null ? readNow() : refresh())).catch(() => {}),
    redrawStrip: drawStrip,
  };
}
