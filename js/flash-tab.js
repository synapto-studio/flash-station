// The Flash Station tab: connect the box, pick the drive, send a link test, new settings or
// a whole engine, and log every send in the drive's history.

import { PulseImage } from './engines.js';
import { Station, StationError, testPlan, patchPlan, fullPlan, planMs, formatDuration } from './station.js';
import { SimStation, SimDrive } from './sim-station.js';
import { WebSerialTransport, webSerialSupported } from './serial.js';
import { Library, MemoryStore, resolveRoutine } from './library.js';

const LAST_KEY = 'flash-station:lastDrive';
const remember = (v) => { try { localStorage.setItem(LAST_KEY, v); } catch {} };
const recall = () => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } };

export function initFlashTab({ $, el, log, state, setLibrary, refreshLibrary }) {
  const fs = { station: null, busy: false, stop: false };

  const pulseDrives = () => state.drives.filter((d) => d.family === 'pulse').sort((a, b) => a.drive.localeCompare(b.drive));
  const selectedDrive = () => pulseDrives().find((d) => d.drive === $('fsDrive').value) || null;
  const engines = () => [
    ...state.engines.filter((e) => e.kind === 'pulsetest'),
    ...(fs.station && fs.station.transport.simulated ? state.demo.filter((e) => e.kind === 'pulsetest') : []),
  ];
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
    if (!drive) return { all: state.library ? 'The register has no Pulse drives yet. Initialise one first.' : 'Choose a library folder: the drive register lives there.' };
    const r = { test: null, settings: null, engine: null };
    if (!engine) r.settings = r.engine = 'Add a pulsetest engine file in the Library tab.';
    else if (drive.engine && drive.engine.label !== engine.label) {
      r.settings = `${drive.drive} runs ${drive.engine.label}. Settings can only go to a drive running the same engine: send the whole engine instead.`;
    }
    if (drive.engine && drive.engine.kind && drive.engine.kind !== 'pulsetest') r.settings = r.engine = `${drive.drive} runs ${drive.engine.label}, which has no bootloader. The station can't send it a new engine; use the Initialise tab.`;
    return r;
  }

  function refreshButtons() {
    const lim = limits();
    const off = (btn, why) => { btn.disabled = fs.busy || !!(lim.all || why); };
    off($('fsTest'), lim.test);
    off($('fsSettings'), lim.settings);
    off($('fsEngineSend'), lim.engine);
    $('fsStop').hidden = !fs.busy;
    for (const id of ['fsDrive', 'fsEngine', 'fsRoutine', 'fsConnect', 'fsSim']) $(id).disabled = fs.busy;
    $('fsDisconnect').hidden = !fs.station;
    const why = lim.all || lim.settings || lim.engine || '';
    $('fsEngineNote').textContent = why;
    const e = selectedEngine();
    if (!why && e) {
      $('fsEngineNote').textContent = e.demo ? 'A demo engine: only for the simulated station.' : `${e.label}, from ${e.fileName}.`;
    }
  }

  // ------------------------------------------------------------ pickers
  function refresh() {
    const drives = pulseDrives();
    const sel = $('fsDrive');
    const prev = sel.value || recall();
    sel.replaceChildren();
    if (!drives.length) sel.append(el('option', { value: '', text: 'No Pulse drives in the register' }));
    for (const d of drives) sel.append(el('option', { value: d.drive, text: `${d.drive} · ${d.board} · ${d.routine || 'engine defaults'}${d.drive === recall() ? ' (last used)' : ''}` }));
    if (drives.some((d) => d.drive === prev)) sel.value = prev;
    $('fsDriveNote').textContent = drives.length ? 'Core drives aren\'t listed: coretest has no receiver yet.' : '';

    const es = $('fsEngine');
    const list = engines();
    const keep = es.value;
    es.replaceChildren();
    if (!list.length) es.append(el('option', { value: '', text: 'No pulsetest engines yet' }));
    list.forEach((e, i) => es.append(el('option', { value: String(i), text: `${e.label}, from ${e.fileName}` })));
    const d = selectedDrive();
    const match = d && d.engine ? list.findIndex((e) => e.fileName === d.engine.file) : -1;
    es.value = match >= 0 ? String(match) : list[Number(keep)] ? keep : list.length ? '0' : '';
    refreshRoutines();
    renderHistory();
    refreshButtons();
  }

  function refreshRoutines() {
    const sel = $('fsRoutine');
    const prev = sel.value;
    const d = selectedDrive();
    sel.replaceChildren(el('option', { value: '', text: 'Engine defaults' }));
    if (d && d.settings) sel.append(el('option', { value: '@drive', text: `Keep ${d.drive}'s current lighting` }));
    for (const r of state.routines.filter((r) => r.data.family === 'pulse')) sel.append(el('option', { value: r.data.name, text: r.data.name }));
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

  $('fsDrive').addEventListener('change', () => { refresh(); });
  $('fsEngine').addEventListener('change', refreshButtons);

  // ------------------------------------------------------------ connecting
  async function useStation(transport, label) {
    const st = new Station(transport);
    await st.connect();
    fs.station = st;
    $('fsStatus').textContent = `${label} connected: station firmware ${st.version}.`;
    log(`Station: ${label}, firmware ${st.version}`);
    refresh();
  }

  $('fsConnect').addEventListener('click', async () => {
    try {
      if (!webSerialSupported()) throw new StationError('Open this page in Chrome or Edge to talk to the station.');
      const t = await WebSerialTransport.request();
      await useStation(t, t.describe());
    } catch (e) {
      if (e.name !== 'NotFoundError') $('fsStatus').textContent = e.message;
      log(`Station: ${e.message}`);
    }
  });

  $('fsSim').addEventListener('click', async () => {
    try {
      if (!state.library) await setLibrary(new Library(new MemoryStore('Demo library (not saved)')));
      if (!pulseDrives().length) await demoDrive();
      await useStation(new SimStation(null), 'Simulated station');
    } catch (e) {
      $('fsStatus').textContent = e.message;
    }
  });

  $('fsDisconnect').addEventListener('click', async () => {
    if (fs.station) await fs.station.close().catch(() => {});
    fs.station = null;
    $('fsStatus').textContent = 'Disconnected.';
    refresh();
  });

  // A made-up P-0001 so the simulated station has something to send to.
  async function demoDrive() {
    const e = state.demo.find((x) => x.kind === 'pulsetest');
    const now = new Date().toISOString();
    await state.library.saveDrive({
      drive: 'P-0001', family: 'pulse', number: 1, board: 'Pulse A2', casing: 'SOTA', chip: 'ATtiny1614',
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
      const built = await build(drive, engine);
      img = built.img;
      settings = built.settings;
      const plan = built.plan;
      if (img) event.imageId = hex4(img.imageId());
      if (built.routine !== undefined) event.routine = built.routine;
      // The simulated station gets a simulated drive that starts as the register says.
      if (fs.station.transport.simulated) fs.station.transport.drive = new SimDrive(new PulseImage(engine.app, engine.version, drive.settings));
      const total = planMs(plan);
      log(`${action} to ${drive.drive}: ${plan.length} sends, about ${formatDuration(total)}`);
      setProgress(`${action}: starting. Keep ${drive.drive} in the socket.`, 0);
      const t0 = Date.now();
      const r = await fs.station.run(plan, {
        shouldStop: () => fs.stop,
        onProgress: ({ done }) => setProgress(`${action}: ${formatDuration(total - done)} to go. Keep ${drive.drive} in the socket.`, done / total),
      });
      event.seconds = Math.round((Date.now() - t0) / 1000);
      event.result = r.completed ? 'Done' : 'Stopped before the end';
      setProgress(r.completed ? `${action}: done. ${how.done}` : `${action}: stopped. ${how.stopped}`, r.completed ? 1 : null);
      if (r.completed && settings) drive.settings = settings;
      if (r.completed && how.engine) drive.engine = { label: engine.label, file: engine.fileName, kind: engine.kind };
      if (r.completed && built.routine !== undefined) drive.routine = built.routine;
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

  const routineName = () => ($('fsRoutine').value === '@drive' || !$('fsRoutine').value ? undefined : $('fsRoutine').value);

  $('fsTest').addEventListener('click', () => {
    const c = $('fsColour').value;
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    go('Link test', async () => ({ plan: testPlan(rgb) }), { done: 'If the drive showed the colour, the link works.', stopped: 'Nothing was saved.' });
  });

  $('fsSettings').addEventListener('click', () =>
    go('Sent settings', async (drive, engine) => {
      const settings = await chosenSettings(drive, engine);
      const img = new PulseImage(engine.app, engine.version, settings);
      return { img, settings: img.settings, plan: patchPlan(img), routine: routineName() };
    }, { done: 'Unplug the drive; it restarts with the new lighting.', stopped: 'The drive keeps its old lighting until a full copy arrives. Send again.' }));

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
