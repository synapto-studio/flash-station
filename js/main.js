// Flash Station app: tabs, the Initialise flow, the library and the drive register.

import { webSerialSupported, WebSerialTransport } from './serial.js';
import { SimChip, SimTransport } from './sim.js';
import { DriveArt } from './drive-art.js';
import { FAMILIES, checkBoard, initialiseBoard, explain, driveRecord } from './initialise.js';
import { buildInitImage, initImageToMem } from './engines.js';
import { toHex } from './intelhex.js';
import { encodeCard, driveLabel } from './idcard.js';
import { Library, MemoryStore, rememberedFolder, reconnectFolder, pickFolder, folderAccessSupported, resolveRoutine } from './library.js';
import { demoEngines } from './demo.js';
import { initFlashTab } from './flash-tab.js';

const $ = (id) => document.getElementById(id);
const CHIP_KEY = { core: 'attiny412', pulse: 'attiny1614' };

const state = {
  family: 'pulse',
  transport: null,
  library: null,
  remembered: null, // a folder picked before that needs permission again
  engines: [],
  demo: demoEngines(),
  routines: [],
  drives: [],
  checked: null,
  busy: false,
  sims: {},
};

const art = new DriveArt($('driveArt'));
let flashTab = null;

// ---------------------------------------------------------------- helpers
function log(msg) {
  const box = $('log');
  box.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}

function stage(title, sub = '', fraction = null) {
  $('stageTitle').textContent = title;
  $('stageSub').textContent = sub;
  $('meterFill').style.width = fraction == null ? '0' : `${Math.round(fraction * 100)}%`;
}

const fam = () => FAMILIES[state.family];
const baud = () => Number($('baud').value);
const simulated = () => !!(state.transport && state.transport.simulated);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

// ---------------------------------------------------------------- tabs
const TABS = ['init', 'station', 'drives', 'library'];
function showTab(name) {
  for (const t of TABS) {
    $(`t-${t}`).setAttribute('aria-selected', String(t === name));
    $(`p-${t}`).hidden = t !== name;
  }
}
for (const t of TABS) $(`t-${t}`).addEventListener('click', () => showTab(t));

// ---------------------------------------------------------------- library
async function setLibrary(lib) {
  state.library = lib;
  await refreshLibrary();
}

async function refreshLibrary() {
  const lib = state.library;
  const chip = $('libChip');
  if (lib) {
    chip.textContent = lib.saved ? `Library: ${lib.name}` : lib.name;
    chip.dataset.state = lib.saved ? 'ok' : '';
  } else if (state.remembered) {
    chip.textContent = 'Reconnect library';
    chip.dataset.state = 'ask';
  } else {
    chip.textContent = 'No library folder';
    chip.dataset.state = '';
  }
  $('pickLibBtn').textContent = state.remembered && !lib ? `Reconnect ${state.remembered.handle.name}` : lib && lib.saved ? 'Choose a different folder' : 'Choose library folder';

  state.engines = lib ? await lib.engines() : [];
  state.drives = lib ? await lib.drives() : [];
  state.routines = lib ? await lib.routines() : [];

  const tb = $('enginesTable').tBodies[0];
  tb.replaceChildren();
  if (!state.engines.length) {
    tb.append(el('tr', {}, el('td', { colspan: 3, text: lib ? 'No engine files yet. Add the .hex files listed below.' : 'Choose a library folder to see its engines.' })));
  }
  for (const e of state.engines) {
    const forWhat = e.family ? `${FAMILIES[e.family].name}${e.kind === 'pulsetest' && !e.hasBootloader ? ' (no bootloader: Flash Station only)' : ''}` : '';
    tb.append(el('tr', {}, el('td', {}, el('code', { text: e.fileName })), el('td', { text: e.label }), el('td', { text: forWhat })));
  }
  if (lib) {
    $('libNote').textContent = lib.saved
      ? `Using the folder "${lib.name}": ${state.engines.length} engine file${state.engines.length === 1 ? '' : 's'}, ${state.routines.length} routine${state.routines.length === 1 ? '' : 's'}, ${state.drives.length} drive${state.drives.length === 1 ? '' : 's'}.`
      : 'This is a demo library for the simulated board. It disappears when the page closes. Choose a folder to keep things.';
  } else {
    $('libNote').textContent = folderAccessSupported()
      ? 'No folder chosen yet. The app still works, but drives are only remembered once a folder is chosen.'
      : 'This browser can\'t open folders. Use Chrome or Edge on a computer.';
  }
  renderDrives();
  refreshEngineOptions();
  if (flashTab) flashTab.refresh();
}

async function chooseLibrary() {
  try {
    if (state.remembered && !(state.library && state.library.saved)) {
      const store = await reconnectFolder(state.remembered.handle);
      state.remembered = null;
      await setLibrary(new Library(store));
    } else {
      const store = await pickFolder();
      state.remembered = null;
      await setLibrary(new Library(store));
    }
    log(`Library folder: ${state.library.name}`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      $('libNote').textContent = e.message;
      log(`Library: ${e.message}`);
    }
  }
}

$('libChip').addEventListener('click', () => {
  if (state.remembered && !state.library) chooseLibrary();
  else showTab('library');
});
$('pickLibBtn').addEventListener('click', chooseLibrary);
$('addEngineBtn').addEventListener('click', () => $('engineFile').click());
$('engineFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    if (!state.library) await setLibrary(new Library(new MemoryStore('Library for this session (not saved)')));
    const engine = await state.library.addEngine(f.name, await f.text());
    log(`Added engine ${f.name}: ${engine.label}`);
    await refreshLibrary();
  } catch (e) {
    $('libNote').textContent = `${f.name}: ${e.message}`;
  }
});

function renderDrives() {
  const table = $('drivesTable');
  const tb = table.tBodies[0];
  tb.replaceChildren();
  const drives = [...state.drives].sort((a, b) => a.drive.localeCompare(b.drive));
  table.hidden = !drives.length;
  $('drivesLead').textContent = drives.length
    ? `${drives.length} drive${drives.length === 1 ? '' : 's'} in the register${state.library && !state.library.saved ? ' (demo library: not saved)' : ''}.`
    : state.library ? 'No drives yet. Initialise a board and it appears here.' : 'Choose a library folder: the register lives there.';
  for (const d of drives) {
    const last = d.history && d.history[d.history.length - 1];
    tb.append(
      el('tr', {},
        el('td', { class: 'drive' }, d.drive, el('span', { class: 'sub', text: d.chip })),
        el('td', { text: d.board }),
        el('td', { text: d.casing || '' }),
        el('td', {}, d.engine.label, el('span', { class: 'sub', text: d.engine.file || '' })),
        el('td', { text: d.routine || 'Engine defaults' }),
        el('td', {}, (d.initialised || '').slice(0, 10), el('span', { class: 'sub', text: last ? `${last.action} ${last.date.slice(0, 10)}` : '' })),
        el('td', {}, el('code', { text: d.chipSerial }))));
  }
}

// ---------------------------------------------------------------- engine and lighting
function enginesForFamily() {
  const kinds = fam().engineKinds;
  const list = state.engines.filter((e) => kinds.includes(e.kind));
  if (simulated()) list.push(...state.demo.filter((e) => kinds.includes(e.kind)));
  return list;
}

function selectedEngine() {
  const i = $('engineSel').value;
  return i === '' ? null : enginesForFamily()[Number(i)] || null;
}

function refreshEngineOptions() {
  const sel = $('engineSel');
  const prev = sel.value;
  const list = enginesForFamily();
  sel.replaceChildren();
  if (!list.length) {
    sel.append(el('option', { value: '', text: `No ${fam().name} engines yet` }));
    sel.disabled = true;
  } else {
    sel.disabled = state.busy;
    list.forEach((e, i) => sel.append(el('option', { value: String(i), text: `${e.label}, from ${e.fileName}` })));
    // prefer a pulsetest file with its bootloader, or a 10 MHz coretest
    const best = list.findIndex((e) => (e.kind === 'pulsetest' && e.hasBootloader) || (e.kind === 'coretest' && e.clock === 10));
    sel.value = prev && list[Number(prev)] ? prev : String(best >= 0 ? best : 0);
  }
  refreshRoutineOptions();
}

function refreshRoutineOptions() {
  const sel = $('routineSel');
  const prev = sel.value;
  const engine = selectedEngine();
  sel.replaceChildren(el('option', { value: '', text: 'Engine defaults' }));
  const onChip = state.checked && state.checked.onChip;
  if (engine && onChip && onChip.engine && onChip.engine.kind === engine.kind) {
    sel.append(el('option', { value: '@chip', text: "Keep the lighting that's on the chip" }));
  }
  for (const r of state.routines.filter((r) => r.data.family === state.family)) {
    sel.append(el('option', { value: r.data.name, text: r.data.name }));
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  sel.disabled = !engine || state.busy;
  describeEngine();
}

function describeEngine() {
  const e = selectedEngine();
  let note = '';
  if (!e) note = state.library ? 'Add this board\'s engine file in the Library tab.' : 'Choose a library folder with your engine files, or use the simulated board to try it out.';
  else if (e.demo) note = 'A demo engine: real settings, made-up code. Only for the simulated board.';
  else if (e.kind === 'pulsetest') note = e.hasBootloader ? 'Bootloader, pulsetest and the BOOTEND fuse (0x0C) go on together.' : 'This file has no bootloader, so it can\'t initialise a board. Use the "_full.hex" file.';
  else if (e.kind === 'coretest') note = e.clock === 10 ? '10 MHz build: the one the Flash Station needs.' : 'Not marked as the 10 MHz build. The Flash Station will need the 10 MHz one ("_10mhz" in its name).';
  else if (e.kind === 'beat') note = 'The older Pulse engine. BOOTEND goes back to 0x00. It has no bootloader, so the Flash Station can only change its settings.';
  $('engineNote').textContent = note;
}

async function selectedSettings(engine) {
  const v = $('routineSel').value;
  if (v === '@chip') return { ...state.checked.onChip.settings };
  if (v) {
    const r = state.routines.find((x) => x.data.name === v);
    return resolveRoutine(state.library, r.data, engine.defaults);
  }
  return null;
}

async function previewLighting() {
  if (state.busy) return;
  const e = selectedEngine();
  $('routineNote').textContent = '';
  if (!e) return;
  try {
    const s = (await selectedSettings(e)) || e.defaults;
    if (!state.busy) {
      art.steady(s);
      $('routineNote').textContent = 'The drawing shows its steady colours (a still, not the animation).';
    }
  } catch (err) {
    $('routineNote').textContent = err.message;
  }
}

$('engineSel').addEventListener('change', () => {
  refreshRoutineOptions();
  previewLighting();
  refreshSteps();
});
$('routineSel').addEventListener('change', previewLighting);

// ---------------------------------------------------------------- board choice
function setFamily(f) {
  if (state.busy || f === state.family) return;
  state.family = f;
  state.checked = null;
  for (const b of document.querySelectorAll('.choice button')) b.setAttribute('aria-checked', String(b.dataset.family === f));
  if (simulated()) useSimulator();
  applyFamily();
  stage('Ready', 'Check the board on the jig.');
  previewLighting();
}

function applyFamily() {
  const F = fam();
  art.setFamily(state.family);
  $('switchV').textContent = F.switchV;
  $('switchWhy').textContent = state.family === 'pulse'
    ? "before the pogo pin touches the board. Never 5V on Pulse: its UPDI pad feeds the mic's 3.3 V rail."
    : 'before the pogo pin touches the board. Core\'s UPDI pad sits at 5 V when it\'s on USB power.';
  for (const s of document.querySelectorAll('.switch-track span')) s.classList.toggle('on', s.dataset.v === F.switchV);
  $('driveLetter').textContent = `${F.letter}-`;
  const bs = $('boardSel');
  bs.replaceChildren(...F.boards.map((b) => el('option', { value: b, text: b })));
  $('boardNote').textContent = state.family === 'pulse'
    ? 'Pulse A2 has the divider fitted, so the Flash Station can update it after sealing. Pulse A1 doesn\'t yet.'
    : '';
  $('facts').hidden = true;
  $('warnings').hidden = true;
  $('driveNum').value = '';
  $('driveWarn').hidden = true;
  refreshEngineOptions();
  refreshSteps();
}

for (const b of document.querySelectorAll('.choice button')) b.addEventListener('click', () => setFamily(b.dataset.family));

// ---------------------------------------------------------------- programmer
function useSimulator() {
  const key = CHIP_KEY[state.family];
  state.sims[key] = state.sims[key] || new SimChip(key);
  state.transport = new SimTransport(state.sims[key], { delayMs: 1 });
  $('progStatus').textContent = `Simulated ${state.sims[key].dev.name} on the pins. Nothing real is flashed, and demo engines are offered.`;
}

$('simBtn').addEventListener('click', async () => {
  useSimulator();
  state.checked = null;
  if (!state.library) await setLibrary(new Library(new MemoryStore('Demo library (not saved)')));
  log('Using the simulated board');
  refreshEngineOptions();
  refreshSteps();
  previewLighting();
});

$('connectBtn').addEventListener('click', async () => {
  try {
    const t = await WebSerialTransport.request();
    state.transport = t;
    state.checked = null;
    $('progStatus').textContent = `UPDI Friend ready (${t.describe()}).`;
    log(`Port chosen: ${t.describe()}`);
    refreshEngineOptions();
  } catch (e) {
    if (e.name !== 'NotFoundError') $('progStatus').textContent = e.message;
  }
  refreshSteps();
});

async function rememberPort() {
  if (!webSerialSupported()) return;
  const ports = await navigator.serial.getPorts();
  const friend = ports.find((p) => (p.getInfo().usbVendorId || 0) === 0x1a86) || (ports.length === 1 ? ports[0] : null);
  if (friend && !state.transport) {
    state.transport = new WebSerialTransport(friend);
    $('progStatus').textContent = `UPDI Friend ready (${state.transport.describe()}), remembered from last time.`;
    refreshSteps();
  }
  navigator.serial.addEventListener('disconnect', (ev) => {
    if (state.transport && state.transport.port === ev.target) {
      state.transport = null;
      state.checked = null;
      $('progStatus').textContent = 'The UPDI Friend was unplugged. Plug it back in and choose it again.';
      refreshSteps();
    }
  });
}

// ---------------------------------------------------------------- check
function fact(dl, label, value, cls) {
  dl.append(el('dt', { text: label }), el('dd', cls ? { class: cls, text: value } : { text: value }));
}

$('checkBtn').addEventListener('click', async () => {
  setBusy(true);
  art.checking();
  stage('Checking', 'Talking to the chip.');
  log(`Checking a ${fam().name} board`);
  try {
    const all = [...state.engines, ...(simulated() ? state.demo : [])];
    const res = await checkBoard(state.transport, state.family, {
      baud: baud(), log, engines: all,
      onProgress: (f) => stage('Checking', "Reading what's on the chip.", f),
    });
    state.checked = { ...res, family: state.family };
    const dl = $('facts');
    dl.replaceChildren();
    fact(dl, 'Chip', `${res.info.device.name}, revision ${res.info.revision} (ID ${res.info.idHex})`, 'good');
    fact(dl, 'Chip serial', res.info.serial);
    fact(dl, 'On it now', res.onChip.match ? `${res.onChip.label}, same as ${res.onChip.match.fileName}` : res.onChip.label);
    fact(dl, 'ID card', res.card ? `${res.card.label}, ${res.card.board}, casing ${res.card.casing || 'none'}, initialised ${res.card.date}` : 'None yet');
    fact(dl, 'BOOTEND fuse', `0x${res.info.fuses[8].toString(16).padStart(2, '0').toUpperCase()}`);
    dl.hidden = false;
    const w = $('warnings');
    w.replaceChildren(...res.warnings.map((x) => el('li', { text: x })));
    w.hidden = !res.warnings.length;
    await suggestDrive(res);
    if (res.onChip.settings) art.steady(res.onChip.settings);
    else art.off();
    stage(res.onChip.blank ? 'Blank board' : 'Board checked', res.card ? `This is ${res.card.label}.` : 'No ID card yet: it gets one when initialised.');
    log(`Checked: ${res.info.device.name} ${res.info.serial}, ${res.onChip.label}${res.card ? `, card ${res.card.label}` : ''}`);
  } catch (e) {
    state.checked = null;
    art.fault();
    stage('Check failed', explain(e, state.family));
    log(`Check failed: ${e.message}`);
  } finally {
    setBusy(false);
    refreshRoutineOptions();
    refreshSteps();
  }
});

async function suggestDrive(res) {
  const F = fam();
  let number = null, board = null, casing = null, why = '';
  if (res.card && res.card.family === F.letter) {
    ({ number, board, casing } = res.card);
    why = `This chip already has ID card ${res.card.label}. Re-initialising keeps the number.`;
  } else if (state.library) {
    const known = await state.library.findDrive({ chipSerial: res.info.serial });
    if (known) {
      ({ number, board, casing } = known);
      why = `The register knows this chip as ${known.drive}.`;
    } else number = await state.library.nextNumber(F.letter);
  }
  $('driveNum').value = number || 1;
  if (board && F.boards.includes(board)) $('boardSel').value = board;
  if (casing) $('casing').value = casing;
  $('driveNum').dataset.cardNumber = res.card ? String(res.card.number) : '';
  $('boardNote').textContent = why || $('boardNote').textContent;
  checkDriveWarn();
}

function checkDriveWarn() {
  const w = $('driveWarn');
  const cardNum = $('driveNum').dataset.cardNumber;
  const n = Number($('driveNum').value);
  if (cardNum && n && String(n) !== cardNum) {
    w.textContent = `This chip's ID card says ${driveLabel(fam().letter, Number(cardNum))}. Initialising will renumber it ${driveLabel(fam().letter, n)}.`;
    w.hidden = false;
  } else w.hidden = true;
  refreshSteps();
}
$('driveNum').addEventListener('input', checkDriveWarn);

// ---------------------------------------------------------------- initialise
function driveInputs() {
  const n = Number($('driveNum').value);
  const ok = Number.isInteger(n) && n >= 1 && n <= 65535;
  return { ok, number: n, label: ok ? driveLabel(fam().letter, n) : '', board: $('boardSel').value, casing: $('casing').value.trim().toUpperCase() };
}

async function buildFor() {
  const engine = selectedEngine();
  if (!engine) throw new Error('Choose an engine first.');
  const settings = await selectedSettings(engine);
  const image = buildInitImage(engine, settings);
  return { engine, image, routineName: $('routineSel').value === '@chip' ? 'Kept from the chip' : $('routineSel').value || null };
}

$('initBtn').addEventListener('click', async () => {
  const d = driveInputs();
  let job;
  try {
    job = await buildFor();
  } catch (e) {
    stage("Can't start", e.message);
    return;
  }
  const card = encodeCard({ family: fam().letter, number: d.number, board: d.board, casing: d.casing });
  const checked = state.checked;
  setBusy(true);
  log(`Initialising ${d.label}: ${job.engine.label} (${job.engine.fileName}), lighting: ${job.routineName || 'engine defaults'}`);
  const names = { erase: 'Erasing', write: 'Writing', verify: 'Verifying', fuse: 'Setting the fuse', card: 'Writing the ID card' };
  const weight = { erase: [0, 0.03], write: [0.03, 0.6], verify: [0.63, 0.32], fuse: [0.95, 0.02], card: [0.97, 0.03] };
  try {
    await initialiseBoard(state.transport, {
      family: state.family, image: job.image, card, engine: job.engine,
      expectSerial: checked.info.serial, baud: baud(), log,
      onStep: (s, f) => {
        if (s === 'done') return;
        const [a, w] = weight[s];
        stage(names[s], s === 'write' ? `${Math.round(f * 100)}% of the engine written.` : s === 'verify' ? 'Reading it all back to compare.' : d.label, a + w * f);
        if (s === 'write') art.progress(f);
        if (s === 'erase') art.progress(0);
      },
    });
    art.steady(job.image.settings);
    stage(`${d.label} initialised`, 'Verified. It starts its load-up as soon as the programmer lets go.', 1);
    log(`${d.label} initialised and verified`);
    if (state.library) {
      const existing = await state.library.findDrive({ chipSerial: checked.info.serial, label: d.label });
      await state.library.saveDrive(driveRecord({
        existing: existing && existing.drive === d.label ? existing : null,
        label: d.label, family: fam().letter, number: d.number, board: d.board, casing: d.casing,
        info: checked.info, engine: job.engine, routineName: job.routineName, image: job.image, settings: job.image.settings,
      }));
      await refreshLibrary();
    } else {
      $('goNote').textContent = 'Done, but not saved in the register: choose a library folder so drives are remembered.';
    }
    state.checked = null;
    $('driveNum').dataset.cardNumber = '';
  } catch (e) {
    art.fault();
    stage('Initialise failed', explain(e, state.family));
    log(`Initialise failed: ${e.message}`);
  } finally {
    setBusy(false);
    refreshSteps();
  }
});

// Terminal fallback: the same image as a .hex, plus the commands.
$('fallbackBtn').addEventListener('click', async () => {
  try {
    const d = driveInputs();
    const { engine, image } = await buildFor();
    const name = `${d.label}_${engine.kind}.hex`;
    const blob = new Blob([toHex(initImageToMem(image))], { type: 'text/plain' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    const card = encodeCard({ family: fam().letter, number: d.number, board: d.board, casing: d.casing });
    const dev = CHIP_KEY[state.family];
    const cmd = $('fallbackCmd');
    cmd.textContent = [
      '# find the UPDI Friend\'s port',
      'ls /dev/cu.usbserial*',
      '# engine, lighting and BOOTEND fuse (replace the port name)',
      `pymcuprog write -t uart -u /dev/cu.usbserial-XXXX -d ${dev} -f ~/Downloads/${name} --erase --verify`,
      `# ID card for ${d.label}`,
      `pymcuprog write -t uart -u /dev/cu.usbserial-XXXX -d ${dev} -m user_row -l ${[...card].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`,
    ].join('\n');
    cmd.hidden = false;
  } catch (e) {
    $('fallbackCmd').textContent = e.message;
    $('fallbackCmd').hidden = false;
  }
});

// ---------------------------------------------------------------- step states and busy
function refreshSteps() {
  const t = state.transport;
  const checked = state.checked && state.checked.family === state.family ? state.checked : null;
  const engine = selectedEngine();
  const engineOk = !!engine && (engine.kind !== 'pulsetest' || engine.hasBootloader);
  const d = driveInputs();
  const ready = !!(t && checked && engineOk && d.ok);
  const set = (name, s) => (document.querySelector(`[data-step="${name}"]`).dataset.state = s);
  set('board', 'done');
  set('prog', t ? 'done' : 'current');
  set('check', checked ? 'done' : t ? 'current' : 'waiting');
  set('engine', !checked ? 'waiting' : engineOk ? 'done' : 'current');
  set('drive', !checked ? 'waiting' : d.ok ? 'done' : 'current');
  set('go', ready ? 'current' : 'waiting');
  $('checkBtn').disabled = state.busy || !t;
  $('initBtn').disabled = state.busy || !ready;
  $('initBtn').textContent = d.ok ? `Initialise ${d.label}` : 'Initialise';
  $('fallbackBtn').disabled = state.busy || !engineOk || !d.ok;
  $('goNote').textContent = !t ? 'Choose the programmer first.' : !checked ? 'Check the board first. Each board is checked before it is written.'
    : !engineOk ? 'Choose an engine with a bootloader.' : 'Erases the chip, writes the engine with its lighting, sets the BOOTEND fuse, then writes the ID card. Everything is read back to check it.';
}

function setBusy(b) {
  state.busy = b;
  for (const id of ['connectBtn', 'simBtn', 'baud', 'engineSel', 'routineSel', 'driveNum', 'boardSel', 'casing', 'pickLibBtn', 'addEngineBtn']) $(id).disabled = b;
  for (const btn of document.querySelectorAll('.choice button')) btn.disabled = b;
  if (!b) refreshEngineOptions();
  refreshSteps();
}

window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- start
async function start() {
  flashTab = initFlashTab({ $, el, log, state, setLibrary, refreshLibrary });
  if (!webSerialSupported()) $('fsConnect').disabled = true;
  if (!webSerialSupported()) {
    $('noSerial').hidden = false;
    $('connectBtn').disabled = true;
  }
  if (!folderAccessSupported()) $('pickLibBtn').disabled = true;
  applyFamily();
  stage('Ready', 'Pick the board on the jig, then the programmer.');
  try {
    state.remembered = await rememberedFolder();
    if (state.remembered && !state.remembered.needsPermission) {
      await setLibrary(new Library(state.remembered.store));
      state.remembered = null;
    } else await refreshLibrary();
  } catch (e) {
    log(`Library: ${e.message}`);
    await refreshLibrary();
  }
  await rememberPort();
  refreshSteps();
  previewLighting();
}

start();
