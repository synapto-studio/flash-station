// The Routines tab: save phase files (settings for one part of the show) and build routines
// that pick one phase file per phase. The logic is in routines.js.

import { Library, MemoryStore } from './library.js';
import { PHASE_LABEL, phasesFor, phaseFields, sharedFields, listPhaseFiles, savePhaseFile, saveRoutine, applyRoutine, describeChanges } from './routines.js';

const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function initRoutinesTab({ $, el, log, state, setLibrary, refreshLibrary }) {
  let inputs = {}; // field name -> input, for the phase being edited
  let sharedInputs = {};
  let phaseFiles = [];

  const engines = () => [...state.engines.filter((e) => e.defaults), ...state.demo];
  const engine = () => engines()[Number($('rtEngine').value)] || null;

  function fieldInput(name, type, label, value) {
    const wrap = el('label', { class: 'field' }, label);
    let input;
    if (type === 'rgb') input = el('input', { type: 'color', value: hex(value) });
    else input = el('input', { type: 'number', value: String(value), step: '1' });
    wrap.append(input);
    return { wrap, input, read: () => (type === 'rgb' ? unhex(input.value) : Number(input.value)) };
  }

  function fill(box, fields, values, store) {
    box.replaceChildren();
    for (const key of Object.keys(store)) delete store[key];
    for (const [name, type, , label] of fields) {
      if (type === 'cranks') continue; // edited in the file for now
      const f = fieldInput(name, type, label, values[name]);
      store[name] = f;
      box.append(f.wrap);
    }
  }

  const readAll = (store) => Object.fromEntries(Object.entries(store).map(([k, f]) => [k, f.read()]));
  // Only what differs from the engine's own settings goes in a phase file.
  const changed = (store, base) => Object.fromEntries(Object.entries(readAll(store)).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k])));

  async function loadFiles() {
    const e = engine();
    phaseFiles = state.library && e ? await listPhaseFiles(state.library, e.tag) : [];
  }

  function refreshEngines() {
    const sel = $('rtEngine');
    const prev = sel.value;
    sel.replaceChildren();
    engines().forEach((e, i) => sel.append(el('option', { value: String(i), text: e.label + (e.fileName ? ` · ${e.fileName}` : '') })));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  async function refresh() {
    refreshEngines();
    await loadFiles();
    const e = engine();
    $('rtNote').textContent = e
      ? state.library ? '' : 'No library folder yet. Saving will use a demo library that disappears when the page closes; choose a folder in the Library tab to keep things.'
      : 'Add an engine file in the Library tab first.';
    const phSel = $('rtPhase');
    const prev = phSel.value;
    phSel.replaceChildren();
    for (const p of e ? phasesFor(e.tag) : []) phSel.append(el('option', { value: p, text: PHASE_LABEL[p] }));
    if ([...phSel.options].some((o) => o.value === prev)) phSel.value = prev;
    refreshBase();
    refreshRoutineForm();
    renderTables();
  }

  // ------------------------------------------------------------ phase files
  function refreshBase() {
    const e = engine(), phase = $('rtPhase').value;
    const sel = $('rtBase');
    sel.replaceChildren(el('option', { value: '', text: 'Engine defaults' }));
    for (const d of phaseFiles.filter((d) => d.phase === phase)) sel.append(el('option', { value: `${d.name}@${d.version}`, text: `${d.name} v${d.version}` }));
    loadBase();
  }

  function loadBase() {
    const e = engine(), phase = $('rtPhase').value;
    if (!e || !phase) return fill($('rtFields'), [], {}, inputs);
    const ref = $('rtBase').value;
    const base = { ...e.defaults };
    if (ref) {
      const [name, v] = ref.split('@');
      const f = phaseFiles.find((d) => d.name === name && String(d.version) === v);
      if (f) Object.assign(base, f.settings);
      $('rtPhaseName').value = name;
    }
    fill($('rtFields'), phaseFields(e.tag, phase), base, inputs);
  }

  async function ensureLibrary() {
    if (!state.library) await setLibrary(new Library(new MemoryStore('Demo library (not saved)')));
    return state.library;
  }

  $('rtSavePhase').addEventListener('click', async () => {
    const e = engine(), phase = $('rtPhase').value;
    try {
      const lib = await ensureLibrary();
      const settings = readAll(inputs);
      const file = await savePhaseFile(lib, { tag: e.tag, phase, name: $('rtPhaseName').value.trim(), settings }, e.defaults);
      $('rtPhaseNote').textContent = `Saved ${file.name} version ${file.version}.`;
      log(`Phase file saved: ${file.name} v${file.version} (${PHASE_LABEL[phase]}, ${e.tag})`);
      await refreshLibrary();
      $('rtBase').value = `${file.name}@${file.version}`;
    } catch (err) {
      $('rtPhaseNote').textContent = err.message;
    }
  });

  // ------------------------------------------------------------ routines
  function refreshRoutineForm() {
    const e = engine();
    const box = $('rtPicks');
    box.replaceChildren();
    if (!e) return;
    for (const p of phasesFor(e.tag).filter((p) => p !== 'recognition')) {
      const sel = el('select', { 'data-phase': p }, el('option', { value: '', text: 'Engine defaults' }));
      const names = [...new Set(phaseFiles.filter((d) => d.phase === p).map((d) => d.name))];
      for (const n of names) {
        const latest = phaseFiles.find((d) => d.phase === p && d.name === n).version;
        sel.append(el('option', { value: n, text: `${n} (newest, v${latest})` }));
        for (let v = latest; v >= 1; v--) if (phaseFiles.some((d) => d.name === n && d.version === v)) sel.append(el('option', { value: `${n}@${v}`, text: `${n} v${v} only` }));
      }
      box.append(el('label', { class: 'field' }, PHASE_LABEL[p], sel));
    }
    fill($('rtShared'), sharedFields(e.tag), e.defaults, sharedInputs);
  }

  $('rtSaveRoutine').addEventListener('click', async () => {
    const e = engine();
    try {
      const lib = await ensureLibrary();
      const phases = {};
      $('rtPicks').querySelectorAll('select').forEach((s) => { if (s.value) phases[s.dataset.phase] = s.value; });
      const routine = await saveRoutine(lib, { tag: e.tag, name: $('rtName').value.trim(), phases, shared: changed(sharedInputs, e.defaults) }, e.defaults);
      $('rtRoutineNote').textContent = `Saved routine ${routine.name}. It's now in the lighting lists on the Initialise and Flash Station tabs.`;
      log(`Routine saved: ${routine.name} (${e.tag})`);
      await refreshLibrary();
    } catch (err) {
      $('rtRoutineNote').textContent = err.message;
    }
  });

  async function renderTables() {
    const e = engine();
    const pt = $('rtPhaseTable').tBodies[0];
    pt.replaceChildren();
    const byName = new Map();
    for (const d of phaseFiles) byName.set(d.name, [...(byName.get(d.name) || []), d]);
    if (!byName.size) pt.append(el('tr', {}, el('td', { colspan: 3, text: 'No phase files for this engine yet.' })));
    for (const [name, list] of byName) {
      pt.append(el('tr', {}, el('td', { text: name }), el('td', { text: PHASE_LABEL[list[0].phase] }), el('td', { text: list.map((d) => `v${d.version}`).join(', ') })));
    }
    const rt = $('rtRoutineTable').tBodies[0];
    rt.replaceChildren();
    const routines = state.routines.filter((r) => e && r.data.tag === e.tag);
    if (!routines.length) rt.append(el('tr', {}, el('td', { colspan: 3, text: 'No routines for this engine yet.' })));
    for (const r of routines) {
      let changes;
      try {
        changes = describeChanges(await applyRoutine(state.library, r.data, e), e.defaults).join(', ') || 'nothing';
      } catch (err) {
        changes = err.message;
      }
      const picks = Object.entries(r.data.phases || {}).map(([p, ref]) => `${PHASE_LABEL[p]}: ${ref}`).join(' · ') || 'none';
      rt.append(el('tr', {}, el('td', { text: r.data.name }), el('td', { text: picks }), el('td', { text: changes })));
    }
  }

  $('rtEngine').addEventListener('change', refresh);
  $('rtPhase').addEventListener('change', refreshBase);
  $('rtBase').addEventListener('change', loadBase);
  return { refresh };
}
