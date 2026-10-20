// The Flash Station tab: connect the box, pick the drive, send a link test, new settings or
// a whole engine (Pulse), or a link test, new settings, forget or hello (Core), and log
// every send in the drive's history. With station 0.2 or later, "Find the drive" asks the
// drive in the socket for its ID card and picks it in the list, and a drive that introduces
// itself on plug-in (coretest 1.4, pulsetest 1.1) pops up in the card on its own. With
// station 0.3 or later nothing is sent to an empty socket, and a drive unplugged mid-send
// leaves the register as it was.

import { PulseImage } from './engines.js';
import {
  Station, StationError, testPlan, patchPlan, fullPlan, planMs, formatDuration,
  coreTestPlan, coreSettingsPlan, coreForgetPlan, coreHelloPlan, parseHello, canListen,
  canTellSocket, afterSend, GONE,
} from './station.js';
import { encodeCard } from './idcard.js';
import { DriveArt } from './drive-art.js';
import { SimStation, SimDrive, SimCoreDrive } from './sim-station.js';
import { WebSerialTransport, webSerialSupported } from './serial.js';
import { Library, MemoryStore, resolveRoutine } from './library.js';

const LAST_KEY = 'flash-station:lastDrive';
const remember = (v) => { try { localStorage.setItem(LAST_KEY, v); } catch {} };
const recall = () => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };

export function initFlashTab({ $, el, log, state, setLibrary, refreshLibrary }) {
  // socket: 'in', 'empty' or null (not known: station 0.1/0.2, or not connected).
  const fs = { station: null, busy: false, stop: false, seen: null, socket: null };
  const tellsSocket = () => !!fs.station && canTellSocket(fs.station.version);
  const emptyNote = (drive) => `The socket is empty. Plug ${drive ? drive.drive : 'the drive'} in, wait for its card, then send.`;
  const cardArt = new DriveArt($('fsCardArt'));

  const KIND = { pulse: 'pulsetest', core: 'coretest' };
  const sendable = () => state.drives.filter((d) => KIND[d.family]).sort((a, b) => a.drive.localeCompare(b.drive));
  const selectedDrive = () => sendable().find((d) => d.drive === $('fsDrive').value) || null;
  const isCore = () => (selectedDrive() || {}).family === 'core';
  const engines = () => {
    const kind = KIND[(selectedDrive() || {}).family] || 'pulsetest';
    return [
      ...state.engines.filter((e) => e.kind === kind),
      ...(fs.station && fs.station.transport.simulated ? state.demo.filter((e) => e.kind === kind) : []),
    ];
  };
  // coretest's receiver arrived in 1.3; a label without a version number is let through.
  const coreTooOld = (label) => {
    const v = /coretest (\d+)\.(\d+)/.exec(label || '');
    return !!v && Number(v[1]) * 1000 + Number(v[2]) < 1003;
  };
  const selectedEngine = () => engines()[Number($('fsEngine').value)] || null;
  const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

  function setProgress(text, fraction = null) {
    $('fsProgress').textContent = text;
    $('fsMeter').style.width = fraction == null ? '0' : `${Math.round(fraction * 100)}%`;
  }

  // ------------------------------------------------------------ what can be sent right now
  function limits() {
    const drive = selectedDrive(), engine = selectedEngine();
    if (!fs.station) return { all: 'Connect the station first.' };
    if (!drive) return { all: state.library ? 'The register has no Pulse or Core drives yet. Initialise one first.' : 'Choose a library folder: the drive register lives there.' };
    if (drive.family === 'core') return coreLimits(drive, engine);
    const r = { test: null, settings: null, engine: null };
    if (!engine) r.settings = r.engine = 'Add a pulsetest engine file in the Library tab.';
    else if (drive.engine && drive.engine.label !== engine.label) {
      r.settings = `${drive.drive} runs ${drive.engine.label}. Settings can only go to a drive running the same engine: send the whole engine instead.`;
    }
    if (drive.engine && drive.engine.kind && drive.engine.kind !== 'pulsetest') r.settings = r.engine = `${drive.drive} runs ${drive.engine.label}, which has no bootloader. The station can't send it a new engine; use the Initialise tab.`;
    return r;
  }

  function coreLimits(drive, engine) {
    const label = drive.engine ? drive.engine.label : '';
    if (coreTooOld(label)) return { all: `${drive.drive} runs ${label}, which can't hear the station. Initialise it with coretest 1.3 or later first.` };
    const r = { test: null, settings: null, engine: 'Core has no bootloader: send a new engine at the Initialisation Station.', forget: null, hello: null };
    if (!engine) r.settings = 'Add a coretest engine file in the Library tab.';
    else if (drive.engine && drive.engine.label !== engine.label) {
      r.settings = `${drive.drive} runs ${drive.engine.label}. Settings can only go to a drive running the same engine: re-initialise it at the Initialisation Station instead.`;
    }
    return r;
  }

  function refreshButtons() {
    const lim = limits();
    const core = isCore();
    // Unplugged (station 0.3): the main button says so (a click still asks the box, in case
    // the drive is back), the other sends wait for a drive.
    const unplugged = fs.socket === 'empty';
    const off = (btn, why, waitsForDrive = true) => { btn.disabled = fs.busy || !!(lim.all || why) || (waitsForDrive && unplugged); };
    off($('fsTest'), lim.test);
    off($('fsSettings'), lim.settings, false);
    off($('fsEngineSend'), lim.engine);
    off($('fsForget'), lim.forget);
    off($('fsHello'), lim.hello);
    const listens = !!fs.station && canListen(fs.station.version);
    $('fsEngineSend').hidden = core;
    $('fsForget').hidden = !core;
    $('fsHello').hidden = !core || listens; // Find does the hello and reads the answer
    $('fsFind').hidden = !fs.station;
    $('fsFind').disabled = fs.busy || !listens;
    if (fs.station && !listens) {
      $('fsFindNote').textContent = `Station firmware ${fs.station.version} can't read a drive's answer. Update the box to station 0.2 to find drives, or pick the drive by hand.`;
    }
    $('fsTest').textContent = `Link test (about ${core ? '4' : '23'} s)`;
    $('fsSettings').textContent = unplugged ? 'Plug the drive in' : `Send settings (about ${core ? '36' : '15'} s)`;
    $('fsStop').hidden = !fs.busy;
    for (const id of ['fsDrive', 'fsEngine', 'fsRoutine', 'fsConnect', 'fsSim', 'fsDisconnect']) $(id).disabled = fs.busy;
    $('fsDisconnect').hidden = !fs.station;
    $('fsSimSocket').hidden = !(fs.station && fs.station.transport.simulated && listens);
    $('fsPlug').disabled = fs.busy;
    $('fsUnplug').disabled = fs.busy || !(fs.station && fs.station.transport.drive);
    const why = lim.all || lim.settings || (core ? '' : lim.engine) || '';
    $('fsEngineNote').textContent = why;
    const e = selectedEngine();
    if (!why && e) {
      $('fsEngineNote').textContent = e.demo ? 'A demo engine: only for the simulated station.' : `${e.label}, from ${e.fileName}.`;
    }
  }

  // ------------------------------------------------------------ pickers
  function refresh() {
    const drives = sendable();
    const sel = $('fsDrive');
    const prev = sel.value || recall();
    const prevFamily = (selectedDrive() || {}).family;
    sel.replaceChildren();
    if (!drives.length) sel.append(el('option', { value: '', text: 'No Pulse or Core drives in the register' }));
    for (const d of drives) sel.append(el('option', { value: d.drive, text: `${d.drive} · ${d.board} · ${d.routine || 'engine defaults'}${d.drive === recall() ? ' (last used)' : ''}` }));
    if (drives.some((d) => d.drive === prev)) sel.value = prev;
    const drive = selectedDrive();
    $('fsDriveNote').textContent = drive && drive.family === 'core'
      ? 'Core: settings arrive at 100 baud, so a send takes about 36 s. The drive restarts its animation when they land.'
      : '';

    const es = $('fsEngine');
    const list = engines();
    const keep = drive && drive.family === prevFamily ? es.value : '';
    es.replaceChildren();
    if (!list.length) es.append(el('option', { value: '', text: `No ${KIND[(drive || {}).family] || 'pulsetest'} engines yet` }));
    list.forEach((e, i) => es.append(el('option', { value: String(i), text: `${e.label}, from ${e.fileName}` })));
    const d = selectedDrive();
    const match = d && d.engine ? list.findIndex((e) => e.fileName === d.engine.file) : -1;
    es.value = match >= 0 ? String(match) : list[Number(keep)] ? keep : list.length ? '0' : '';
    refreshRoutines();
    renderHistory();
    renderCard();
    refreshSimSocket();
    refreshButtons();
  }

  // ------------------------------------------------------------ the drive card
  // Shows the drive picked in the list, or one the station just heard that isn't in the
  // register. fs.seen says how the station last identified a drive: { label, board, how }.
  function renderCard() {
    const d = selectedDrive();
    const seen = fs.seen;
    const unknown = seen && !seen.known ? seen : null;
    $('fsCard').hidden = !d && !unknown;
    if (!d && !unknown) return;
    const label = unknown ? unknown.label : d.drive;
    const fresh = !!seen && seen.label === label;
    const gone = fresh && fs.socket === 'empty';
    $('fsCard').toggleAttribute('data-fresh', fresh && !gone);
    $('fsCard').toggleAttribute('data-gone', gone);
    $('fsCardTag').textContent = gone ? 'Unplugged' : fresh ? (seen.how === 'plug' ? 'Just plugged in' : 'Found by station hello') : 'Picked in the list';
    $('fsCardLabel').textContent = label;
    const facts = unknown
      ? [['Board', unknown.board], ['Register', "Not in this library's register. Choose the library folder it was initialised with."]]
      : (() => {
          const last = d.history && d.history.length ? d.history[d.history.length - 1] : null;
          return [
            ['Board', d.board],
            ['Engine', d.engine ? d.engine.label : 'Unknown'],
            ['Lighting', d.routine || 'Engine defaults'],
            ['Last send', last ? `${last.action}, ${(last.result || 'Done').toLowerCase()}, ${last.date.slice(0, 10)}` : 'Nothing sent yet'],
            ['Initialised', `${(d.initialised || '').slice(0, 10) || 'Unknown'}${d.casing ? ` · casing ${d.casing}` : ''}`],
          ];
        })();
    $('fsCardFacts').replaceChildren(...facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
    const family = unknown ? unknown.family : d.family;
    cardArt.setFamily(family === 'core' ? 'core' : 'pulse');
    cardArt.steady(unknown ? null : d.settings);
  }

  // Picks the drive the station heard and shows it in the card.
  function identified(heard, how) {
    const found = state.drives.find((d) => d.drive === heard.label) || null;
    fs.seen = { label: heard.label, board: heard.board, family: heard.family, how, known: !!found };
    if (found) {
      $('fsDrive').value = found.drive;
      remember(found.drive);
    }
    refresh();
    return found;
  }

  function refreshRoutines() {
    const sel = $('fsRoutine');
    const prev = sel.value;
    const d = selectedDrive();
    sel.replaceChildren(el('option', { value: '', text: 'Engine defaults' }));
    if (d && d.settings) sel.append(el('option', { value: '@drive', text: `Keep ${d.drive}'s current lighting` }));
    for (const r of state.routines.filter((r) => r.data.family === (d ? d.family : 'pulse'))) sel.append(el('option', { value: r.data.name, text: r.data.name }));
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : d && d.routine && [...sel.options].some((o) => o.value === d.routine) ? d.routine : d && d.settings ? '@drive' : '';
  }

  function renderHistory() {
    const d = selectedDrive();
    const tb = $('fsHistory').tBodies[0];
    tb.replaceChildren();
    const hist = d && d.history ? [...d.history].reverse().slice(0, 12) : [];
    $('fsHistory').hidden = !hist.length;
    $('fsHistoryNote').textContent = d ? (hist.length ? '' : 'Nothing logged yet.') : '';
    for (const h of hist) {
      tb.append(el('tr', {}, el('td', { text: h.date.slice(0, 16).replace('T', ' ') }), el('td', { text: h.station || '' }), el('td', { text: h.action }), el('td', { text: h.engine || '' }), el('td', { text: h.result || 'Done' })));
    }
  }

  $('fsDrive').addEventListener('change', () => {
    fs.seen = null;
    refresh();
  });
  $('fsEngine').addEventListener('change', refreshButtons);

  // ------------------------------------------------------------ connecting
  async function useStation(transport, label) {
    const st = new Station(transport);
    await st.connect();
    fs.station = st;
    fs.socket = null;
    $('fsFindNote').textContent = '';
    const tells = canTellSocket(st.version);
    $('fsStatus').textContent = `${label} connected: station firmware ${st.version}.${tells ? '' : " This box can't tell if the socket is empty: update it to station 0.3."}`;
    log(`Station: ${label}, firmware ${st.version}`);
    if (tells) fs.socket = (await st.socket()) ? 'in' : 'empty';
    refresh();
    if (canListen(st.version)) watch(st);
  }

  // While the station is connected and nothing is being sent, keep a WAIT going so a drive
  // that introduces itself pops up as soon as it's plugged in. A send asked for meanwhile
  // goes once the current WAIT ends (1 s at most).
  const WAIT_MS = 1000;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // The box's USB connection went away (unplugged, or restarting after new firmware was
  // copied onto it): stop talking to it and say so once.
  function stationLost(st) {
    if (fs.station !== st) return;
    fs.station = null;
    fs.socket = null;
    st.close().catch(() => {});
    $('fsStatus').textContent = 'The station was disconnected (unplugged, or restarting after new firmware). Plug it in, then Choose the station again.';
    log('Station disconnected');
    refresh();
  }
  if (typeof navigator !== 'undefined' && navigator.serial) {
    navigator.serial.addEventListener('disconnect', (ev) => {
      if (fs.station && fs.station.transport.port === ev.target) stationLost(fs.station);
    });
  }

  async function watch(st) {
    let lastError = '';
    while (fs.station === st) {
      if (fs.busy) { await pause(200); continue; }
      let bytes;
      try {
        bytes = await st.wait(WAIT_MS);
        lastError = '';
      } catch (e) {
        if (fs.station !== st) return;
        if (st.transport.lost) { stationLost(st); return; }
        if (e.message !== lastError) log(`Station: ${e.message}`);   // once, not every second
        lastError = e.message;
        await pause(WAIT_MS);
        continue;
      }
      if (fs.station !== st || bytes === null) continue;
      if (bytes === GONE) {
        fs.socket = 'empty';
        log(`Unplugged${fs.seen ? `: ${fs.seen.label}` : ''}`);
        $('fsFindNote').textContent = '';
        refresh();
        continue;
      }
      if (tellsSocket()) fs.socket = 'in';
      const heard = parseHello(bytes);
      if (!heard || heard.blank) {
        fs.seen = null; // whatever the card said was plugged in before has gone
        refresh();
      }
      if (!heard) {
        log('A drive was plugged in but didn\'t say who it is');
        $('fsFindNote').textContent = "A drive was plugged in but didn't say who it is. Only coretest 1.4 and pulsetest 1.4 or later introduce themselves: use Find, or pick it in the list.";
      } else if (heard.blank) {
        log('A drive with no ID card was plugged in');
        $('fsFindNote').textContent = 'A drive was plugged in, but it has no ID card. Give it one at the Initialisation Station.';
      } else {
        // 1.5 drives also say what lighting they have (checking it against the register: roadmap task 7)
        const fp = heard.fingerprint == null ? '' : `, lighting fingerprint ${heard.fingerprint.toString(16).toUpperCase().padStart(4, '0')}`;
        log(`Plugged in: ${heard.label} (${heard.board})${fp}`);
        $('fsFindNote').textContent = '';
        identified(heard, 'plug');
      }
      if (tellsSocket()) await logLevels(st);
    }
  }

  // Station 0.3 measures the sense wire at each plug-in: logged for the bench numbers.
  async function logLevels(st) {
    try {
      const lv = await st.levels();
      if (lv) log(`Socket levels: empty ${lv.empty}, drive in ${lv.in}, in a dip ${lv.dip}, while it answered ${lv.low}–${lv.high}`);
    } catch (e) {
      log(`Socket levels: ${e.message}`);
    }
  }

  // Station 0.3: is there a drive to send to? Asks the box (it checks with one 5 ms dip if it
  // isn't sure). Older boxes can't tell: true.
  async function socketHasDrive() {
    if (!tellsSocket()) return true;
    const inSocket = await fs.station.socket();
    fs.socket = inSocket ? 'in' : 'empty';
    return inSocket;
  }

  $('fsConnect').addEventListener('click', async () => {
    try {
      if (!webSerialSupported()) throw new StationError('Open this page in Chrome or Edge to talk to the station.');
      const t = await WebSerialTransport.request();
      // Choosing the station again while connected: let go of the old connection first,
      // or Chrome says the port is already open.
      if (fs.station) {
        await fs.station.close().catch(() => {});
        fs.station = null;
      }
      await useStation(t, t.describe());
    } catch (e) {
      if (e.name !== 'NotFoundError') $('fsStatus').textContent = e.message;
      log(`Station: ${e.message}`);
    }
  });

  $('fsSim').addEventListener('click', async () => {
    try {
      if (!state.library) await setLibrary(new Library(new MemoryStore('Demo library (not saved)')));
      if (!sendable().some((d) => d.family === 'pulse')) await demoDrive('pulse');
      if (!sendable().some((d) => d.family === 'core')) await demoDrive('core');
      await useStation(new SimStation(null, { version: '0.3' }), 'Simulated station');
    } catch (e) {
      $('fsStatus').textContent = e.message;
    }
  });

  $('fsDisconnect').addEventListener('click', async () => {
    if (fs.station) await fs.station.close().catch(() => {});
    fs.station = null;
    fs.seen = null;
    fs.socket = null;
    $('fsStatus').textContent = 'Disconnected.';
    refresh();
  });

  // A made-up P-0001 or C-0001 so the simulated station has something to send to.
  async function demoDrive(family) {
    const e = state.demo.find((x) => x.kind === KIND[family]);
    const now = new Date().toISOString();
    const who = family === 'core'
      ? { drive: 'C-0001', board: 'Core A', chip: 'ATtiny412' }
      : { drive: 'P-0001', board: 'Pulse A2', chip: 'ATtiny1614' };
    await state.library.saveDrive({
      ...who, family, number: 1, casing: 'SOTA',
      engine: { label: e.label, file: e.fileName, kind: e.kind }, routine: null, settings: e.defaults,
      initialised: now, updated: now, history: [],
    });
    await refreshLibrary();
  }

  // ------------------------------------------------------------ sending
  async function chosenSettings(drive, engine) {
    const v = $('fsRoutine').value;
    if (v === '@drive') return { ...drive.settings };
    if (v) return resolveRoutine(state.library, state.routines.find((r) => r.data.name === v).data, engine.defaults);
    return { ...engine.defaults };
  }

  async function go(action, build, how) {
    if (fs.busy) return;
    const drive = selectedDrive(), engine = selectedEngine();
    fs.busy = true;
    fs.stop = false;
    refreshButtons();
    const event = { date: new Date().toISOString(), station: 'Flash Station', action, engine: engine ? engine.label : '' };
    let settings = null, img = null;
    try {
      if (!(await socketHasDrive())) {
        setProgress(emptyNote(drive));
        log(`${action} to ${drive.drive}: not sent, the socket is empty`);
        fs.busy = false;
        refresh();
        return;
      }
      const built = await build(drive, engine);
      img = built.img;
      settings = built.settings;
      const plan = built.plan;
      if (img) event.imageId = hex4(img.imageId());
      if (built.routine !== undefined) event.routine = built.routine;
      // The simulated station gets a simulated drive that starts as the register says.
      if (fs.station.transport.simulated && fs.station.transport.drive) {
        fs.station.transport.drive = drive.family === 'core'
          ? simCoreDrive(drive, engine)
          : new SimDrive(new PulseImage(engine.app, engine.version, drive.settings));
      }
      const total = planMs(plan);
      log(`${action} to ${drive.drive}: ${plan.length} sends, about ${formatDuration(total)}`);
      setProgress(`${action}: starting. Keep ${drive.drive} in the socket.`, 0);
      const t0 = Date.now();
      const r = await fs.station.run(plan, {
        shouldStop: () => fs.stop,
        onProgress: ({ done }) => setProgress(`${action}: ${formatDuration(total - done)} to go. Keep ${drive.drive} in the socket.`, done / total),
      });
      event.seconds = Math.round((Date.now() - t0) / 1000);
      const after = afterSend(drive, r, {
        plan, settings, routine: built.routine, forget: !!how.forget,
        engine: how.engine ? { label: engine.label, file: engine.fileName, kind: engine.kind } : null,
      });
      event.result = after.result;
      if (r.completed) setProgress(`${action}: done. ${how.done}`, 1);
      else if (!r.empty) setProgress(`${action}: stopped. ${how.stopped}`);
      else {
        // The box found the socket empty: the register keeps the lighting and engine it had.
        fs.socket = 'empty';
        setProgress(`${action}: ${after.result}. ${after.got === 'nothing' ? emptyNote(drive) : `Plug ${drive.drive} back in and send again.`}`);
      }
    } catch (e) {
      event.result = `Failed: ${e.message}`;
      setProgress(`${action} failed. ${e.message}`);
      log(`${action}: ${e.message}`);
      if (e instanceof StationError) $('fsStatus').textContent = e.message;
    }
    try {
      if (state.library && drive) {
        drive.history = [...(drive.history || []), event];
        drive.updated = event.date;
        await state.library.saveDrive(drive);
      }
      remember(drive.drive);
    } catch (e) {
      log(`Couldn't write the drive's history: ${e.message}`);
    }
    fs.busy = false;
    log(`${action}: ${event.result}`);
    refresh();
  }

  // A simulated Core: its flash holds the settings it was initialised with, its EEPROM the
  // ones sent since (if any), its user row the ID card, as the register says.
  function simCoreDrive(drive, engine) {
    let card = null;
    try { card = encodeCard({ family: 'C', number: drive.number, board: drive.board }); } catch {}
    const sim = new SimCoreDrive(drive.flashedSettings || drive.settings || engine.defaults, card);
    if (drive.flashedSettings && drive.settings) sim.feed(coreSettingsPlan(drive.settings)[0].bytes);
    sim.eeWrites = sim.restarts = sim.heard = 0;
    return sim;
  }

  const routineName = () => ($('fsRoutine').value === '@drive' || !$('fsRoutine').value ? undefined : $('fsRoutine').value);

  $('fsTest').addEventListener('click', () => {
    const c = $('fsColour').value;
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const plan = isCore() ? coreTestPlan(rgb) : testPlan(rgb);
    go('Link test', async () => ({ plan }), { done: 'If the drive showed the colour, the link works.', stopped: 'Nothing was saved.' });
  });

  $('fsSettings').addEventListener('click', () =>
    go('Sent settings', async (drive, engine) => {
      const settings = await chosenSettings(drive, engine);
      if (drive.family === 'core') {
        return { settings, plan: coreSettingsPlan(settings), routine: routineName() };
      }
      const img = new PulseImage(engine.app, engine.version, settings);
      return { img, settings: img.settings, plan: patchPlan(img), routine: routineName() };
    }, isCore()
      ? { done: 'The drive restarts its animation with the new lighting; it keeps it after unplugging.', stopped: 'The drive keeps its old lighting until a full copy arrives. Send again.' }
      : { done: 'Unplug the drive; it restarts with the new lighting.', stopped: 'The drive keeps its old lighting until a full copy arrives. Send again.' }));

  $('fsForget').addEventListener('click', () =>
    go('Forgot sent settings', async () => ({ plan: coreForgetPlan() }), {
      done: 'The drive is back on the settings it was initialised with and restarts its animation.',
      stopped: 'If a full copy arrived the drive went back to its flashed settings; send again to be sure.',
      forget: true,
    }));

  $('fsHello').addEventListener('click', () =>
    go('Station hello', async () => ({ plan: coreHelloPlan() }), {
      done: 'The drive should have flickered white for 3 s. This station firmware can\'t read the answer; station 0.2 can.',
      stopped: 'Nothing was saved.',
    }));

  // ------------------------------------------------------------ finding the drive in the socket
  // One station hello; the drive flickers its ID back, the box reads it on the sense wire and
  // the drive is picked in the list. Only Core (coretest 1.3 on) answers so far.
  async function findDrive() {
    if (fs.busy) return;
    fs.busy = true;
    refreshButtons();
    const note = (t) => { $('fsFindNote').textContent = t; };
    note('Asking the drive in the socket who it is. Keep it in the socket…');
    let found = null, result;
    try {
      if (!(await socketHasDrive())) {
        note('The socket is empty. Plug the drive in, then try again.');
        log('Find the drive: the socket is empty');
        fs.busy = false;
        refresh();
        return;
      }
      if (fs.station.transport.simulated) {
        // The simulated socket holds the Core picked in the list, or the first one.
        const d = sendable().find((x) => x.family === 'core' && x.drive === $('fsDrive').value) || sendable().find((x) => x.family === 'core');
        if (fs.station.transport.drive || !tellsSocket()) fs.station.transport.drive = d ? simCoreDrive(d, state.demo.find((x) => x.kind === 'coretest')) : null;
      }
      const answer = await fs.station.ask(coreHelloPlan()[0]);
      const heard = answer && parseHello(answer);
      if (answer === null) {
        fs.socket = 'empty';
        result = 'The socket is empty';
        note('The drive was unplugged. Plug it back in, then try again.');
      } else if (!heard) {
        result = 'No answer';
        note('No answer. Push the drive all the way into the socket and try again. Only Core drives on coretest 1.3 or later answer so far; for a Pulse, pick it in the list.');
      } else if (heard.blank) {
        result = 'A drive with no ID card';
        note('A drive answered, but it has no ID card. Give it one at the Initialisation Station.');
      } else {
        found = identified(heard, 'find');
        result = `Found ${heard.label}`;
        if (found) {
          note(`Found ${heard.label} (${heard.board}). It's picked in the list.`);
        } else {
          note(`Found ${heard.label} (${heard.board}), but it isn't in this library's register. Choose the library folder it was initialised with.`);
        }
      }
    } catch (e) {
      result = `Failed: ${e.message}`;
      note(`Couldn't ask the drive. ${e.message}`);
      if (e instanceof StationError) $('fsStatus').textContent = e.message;
    }
    log(`Find the drive: ${result}`);
    if (found && state.library) {
      try {
        const date = new Date().toISOString();
        found.history = [...(found.history || []), { date, station: 'Flash Station', action: 'Station hello', engine: found.engine ? found.engine.label : '', result }];
        found.updated = date;
        await state.library.saveDrive(found);
      } catch (e) {
        log(`Couldn't write the drive's history: ${e.message}`);
      }
    }
    fs.busy = false;
    refresh();
  }

  $('fsFind').addEventListener('click', findDrive);

  // ------------------------------------------------------------ the simulated socket
  // Stands in for a hand at the socket: plug in any drive from the register as if it ran an
  // engine that introduces itself, or one that can't (older engine) or isn't registered.
  const OLD = '@old', STRANGER = '@stranger';
  function refreshSimSocket() {
    const sel = $('fsSimDrive');
    const prev = sel.value;
    sel.replaceChildren(
      ...sendable().map((d) => el('option', { value: d.drive, text: `${d.drive} · ${d.board}` })),
      el('option', { value: OLD, text: 'A Core on coretest 1.3 (says nothing)' }),
      el('option', { value: STRANGER, text: 'C-0099, not in this register' }),
    );
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  $('fsPlug').addEventListener('click', () => {
    const v = $('fsSimDrive').value;
    const core = state.demo.find((x) => x.kind === 'coretest');
    let sim;
    if (v === OLD || v === STRANGER) {
      sim = new SimCoreDrive(core.defaults, encodeCard({ family: 'C', number: v === OLD ? 1 : 99, board: 'Core A' }));
      sim.announces = v === STRANGER;
    } else {
      const d = sendable().find((x) => x.drive === v);
      if (d.family === 'core') sim = simCoreDrive(d, core);
      else {
        const e = state.demo.find((x) => x.kind === 'pulsetest');
        let card = null;
        try { card = encodeCard({ family: 'P', number: d.number, board: d.board }); } catch {}
        sim = new SimDrive(new PulseImage(e.app, e.version, d.settings), card);
      }
      sim.announces = true;
    }
    log(`Simulated socket: plugged in ${$('fsSimDrive').selectedOptions[0].text}`);
    fs.station.transport.plugIn(sim);
    refreshButtons();
  });

  $('fsUnplug').addEventListener('click', () => {
    log('Simulated socket: unplugged');
    fs.station.transport.unplug();
    refreshButtons();
  });

  $('fsEngineSend').addEventListener('click', () => {
    if (!window.confirm('Send the whole engine? It takes 3 to 6 minutes. Keep the drive in the socket the whole time.')) return;
    go('Sent engine', async (drive, engine) => {
      const settings = await chosenSettings(drive, engine);
      const img = new PulseImage(engine.app, engine.version, settings);
      return { img, settings: img.settings, plan: fullPlan(img), routine: routineName() };
    }, { done: 'Unplug the drive; it restarts on the new engine.', stopped: 'The drive is marked unfinished and waits for the rest. Plug it back in and send again.', engine: true });
  });

  $('fsStop').addEventListener('click', () => {
    fs.stop = true;
    $('fsStop').disabled = true;
    setProgress('Stopping after the current send…');
  });

  return { refresh };
}
