// The Routines tab: phase files, colour sets, routines and drive profiles.
// All the rules live in routines.js; this file is the screen.

import { Library, MemoryStore } from './library.js';
import { DriveArt } from './drive-art.js';
import { PULSE_DEFAULTS, CORE_DEFAULTS } from './demo.js';
import {
  PHASES, ENGINES, LED_COUNT, phaseFields, colourFields, phaseFiles,
  savePhase, savePalette, saveRoutine, resolveRoutine, saveProfile, defaultProfile,
} from './routines.js';

const RANGE = { u8: [0, 255], i8: [-128, 127], u16: [0, 65535], u32: [0, 4294967295] };
const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function initEditor({ $, el, log, state, refreshLibrary }) {
  const art = new DriveArt($('edArt'));
  const ed = { tag: 'SOTA.PLS', values: {}, colours: {}, profile: null };
  const busy = (msg, bad = false) => {
    $('edStatus').textContent = msg;
    $('edStatus').classList.toggle('warn', bad);
  };

  // Engine defaults for a layout: a library engine if there is one, else the built-in set.
  function defaultsFor(tag) {
    const found = state.engines.find((e) => e.tag === tag && e.defaults);
    if (found) return found.defaults;
    if (tag === 'SOTA.PLS') return PULSE_DEFAULTS;
    if (tag === 'SOTA.LED') return CORE_DEFAULTS;
    return null;
  }
  const defaults = () => defaultsFor(ed.tag);

  async function ensureLibrary() {
    if (!state.library) {
      state.library = new Library(new MemoryStore('Library for this session (not saved)'));
      await refreshLibrary();
    }
    return state.library;
  }

  // ---------------------------------------------------------------- engine choice
  function refreshEngineChoice() {
    const sel = $('edEngine');
    const prev = ed.tag;
    sel.replaceChildren();
    for (const [tag, info] of Object.entries(ENGINES)) {
      if (!defaultsFor(tag)) continue;
      sel.append(el('option', { value: tag, text: `${info.family === 'pulse' ? 'Pulse' : 'Core'} · ${info.name}` }));
    }
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : sel.options[0].value;
    ed.tag = sel.value;
  }

  // ---------------------------------------------------------------- field editors
  function numberField(name, type, label, value, onChange) {
    const [lo, hi] = RANGE[type];
    const input = el('input', { type: 'number', min: lo, max: hi, step: 1, inputmode: 'numeric' });
    input.value = value;
    input.addEventListener('input', () => onChange(input.value === '' ? NaN : Number(input.value)));
    return el('label', { class: 'field' }, label || name, input);
  }

  function colourField(name, label, value, onChange) {
    const input = el('input', { type: 'color', value: hex(value) });
    input.addEventListener('input', () => onChange(unhex(input.value)));
    return el('label', { class: 'field colour' }, label || name, input);
  }

  function cranksField(value, onChange) {
    const rows = value.map((c) => [...c]);
    const table = el('table', { class: 'table cranks' }, el('thead', {}, el('tr', {}, ...['Crank', 'On ms', 'Off ms', 'Peak'].map((t) => el('th', { text: t })))));
    const tb = el('tbody');
    rows.forEach((row, i) => {
      const tr = el('tr', {}, el('td', { text: String(i + 1) }));
      row.forEach((v, j) => {
        const input = el('input', { type: 'number', min: 0, max: j === 2 ? 255 : 65535, step: 1 });
        input.value = v;
        input.addEventListener('input', () => {
          rows[i][j] = Number(input.value);
          onChange(rows.map((r) => [...r]));
        });
        tr.append(el('td', {}, input));
      });
      tb.append(tr);
    });
    table.append(tb);
    return table;
  }

  function renderFields(host, fields, bag, onChange) {
    host.replaceChildren();
    for (const [name, type, , label] of fields) {
      const set = (v) => {
        bag[name] = v;
        onChange();
      };
      if (type === 'rgb') host.append(colourField(name, label, bag[name], set));
      else if (type === 'cranks') host.append(el('div', { class: 'wide-field' }, el('p', { class: 'field-label', text: label }), cranksField(bag[name], set)));
      else host.append(numberField(name, type, label, bag[name], set));
    }
  }

  // ---------------------------------------------------------------- preview
  async function preview(settings) {
    art.setFamily(ENGINES[ed.tag].family);
    try {
      art.steady(settings);
      $('edPreviewNote').textContent = 'A still of the steady colours and levels. The moving preview arrives when the SOTA LED and Pulse preview pages are added to the repo.';
    } catch (e) {
      $('edPreviewNote').textContent = e.message;
    }
  }

  // ---------------------------------------------------------------- phase files
  let phaseList = [];
  async function refreshPhase() {
    const phase = $('edPhase').value;
    const fields = phaseFields(ed.tag, phase);
    const info = PHASES.find((p) => p.key === phase);
    $('edPhaseNote').textContent = info.note;
    const sel = $('edPhaseFile');
    sel.replaceChildren(el('option', { value: '', text: 'New phase file' }));
    phaseList = state.library ? await phaseFiles(state.library, phase, ed.tag) : [];
    phaseList.forEach((p, i) => sel.append(el('option', { value: String(i), text: `${p.name}@${p.version}` })));
    sel.value = '';
    $('edPhaseFields').hidden = !fields.length;
    $('edPhaseSave').disabled = !fields.length;
    $('edPhaseName').disabled = !fields.length;
    loadPhaseValues();
  }

  function loadPhaseValues() {
    const phase = $('edPhase').value;
    const fields = phaseFields(ed.tag, phase);
    const picked = phaseList[Number($('edPhaseFile').value)];
    const base = structuredClone(defaults());
    if (picked) {
      Object.assign(base, picked.settings);
      $('edPhaseName').value = picked.name;
    }
    ed.values = base;
    renderFields($('edPhaseFields'), fields, ed.values, () => preview(ed.values));
    preview(ed.values);
  }

  $('edPhaseSave').addEventListener('click', async () => {
    try {
      const lib = await ensureLibrary();
      const saved = await savePhase(lib, { name: $('edPhaseName').value, phase: $('edPhase').value, tag: ed.tag, defaults: defaults(), settings: ed.values });
      busy(`Saved ${saved.name}@${saved.version} (${saved.phase}).${lib.saved ? '' : ' Not kept after this page closes: choose a library folder.'}`);
      log(`Phase file ${saved.name}@${saved.version} (${saved.phase}, ${ENGINES[ed.tag].name})`);
      await refreshAll();
      $('edPhaseFile').value = String(phaseList.findIndex((p) => p.name === saved.name && p.version === saved.version));
    } catch (e) {
      busy(e.message, true);
    }
  });

  // ---------------------------------------------------------------- colour sets
  let paletteList = [];
  async function refreshPalettes() {
    paletteList = state.library ? (await state.library.palettes()).filter((p) => p.tag === ed.tag) : [];
    const sel = $('edPalette');
    sel.replaceChildren(el('option', { value: '', text: 'New colour set' }));
    paletteList.forEach((p, i) => sel.append(el('option', { value: String(i), text: p.name })));
    sel.value = '';
    loadPalette();
    const rs = $('edRoutinePalette');
    const prev = rs.value;
    rs.replaceChildren(el('option', { value: '', text: 'None (engine colours)' }));
    paletteList.forEach((p) => rs.append(el('option', { value: p.name, text: p.name })));
    rs.value = [...rs.options].some((o) => o.value === prev) ? prev : '';
  }

  function loadPalette() {
    const picked = paletteList[Number($('edPalette').value)];
    const d = defaults();
    ed.colours = {};
    for (const [name] of colourFields(ed.tag)) ed.colours[name] = [...(picked && picked.colours[name] ? picked.colours[name] : d[name])];
    if (picked) $('edPaletteName').value = picked.name;
    renderFields($('edPaletteFields'), colourFields(ed.tag), ed.colours, () => preview({ ...d, ...ed.colours }));
    preview({ ...d, ...ed.colours });
  }

  $('edPaletteSave').addEventListener('click', async () => {
    try {
      const lib = await ensureLibrary();
      const saved = await savePalette(lib, { name: $('edPaletteName').value, tag: ed.tag, defaults: defaults(), colours: ed.colours });
      busy(`Saved colour set ${saved.name}.${lib.saved ? '' : ' Not kept after this page closes: choose a library folder.'}`);
      log(`Colour set ${saved.name} (${ENGINES[ed.tag].name})`);
      await refreshAll();
      $('edPalette').value = String(paletteList.findIndex((p) => p.name === saved.name));
    } catch (e) {
      busy(e.message, true);
    }
  });

  // ---------------------------------------------------------------- routines
  async function refreshRoutine() {
    const host = $('edRoutinePhases');
    host.replaceChildren();
    for (const p of PHASES) {
      if (!phaseFields(ed.tag, p.key).length) continue;
      const files = state.library ? await phaseFiles(state.library, p.key, ed.tag) : [];
      const sel = el('select', { 'data-phase': p.key }, el('option', { value: '', text: 'Engine default' }));
      const names = [...new Set(files.map((f) => f.name))];
      for (const n of names) {
        const newest = files.find((f) => f.name === n).version;
        sel.append(el('option', { value: n, text: `${n} (newest, now @${newest})` }));
        files.filter((f) => f.name === n).forEach((f) => sel.append(el('option', { value: `${n}@${f.version}`, text: `${n}@${f.version}` })));
      }
      sel.addEventListener('change', previewRoutine);
      host.append(el('label', { class: 'field' }, p.label, sel));
    }
    const routines = state.library ? await state.library.routines() : [];
    const rsel = $('edRoutineOpen');
    rsel.replaceChildren(el('option', { value: '', text: 'New routine' }));
    routines.filter((r) => r.data.tag === ed.tag).forEach((r) => rsel.append(el('option', { value: r.data.name, text: r.data.name })));
    rsel.value = '';
    previewRoutine();
  }

  function routineFromForm() {
    const phases = {};
    for (const sel of $('edRoutinePhases').querySelectorAll('select')) phases[sel.dataset.phase] = sel.value || null;
    const shared = {};
    const b = $('edRoutineBrightness').value;
    if (b !== '') shared.brightness = Number(b);
    return { name: $('edRoutineName').value, tag: ed.tag, defaults: defaults(), phases, palette: $('edRoutinePalette').value || null, shared };
  }

  async function previewRoutine() {
    const r = routineFromForm();
    try {
      const s = await resolveRoutine(state.library || new Library(new MemoryStore()), { ...r, name: r.name || 'this routine' }, defaults());
      $('edRoutineValues').textContent = `Sends: brightness ${s.brightness}, red ${s.red.join(', ')}, orange ${s.orange.join(', ')}.`;
      preview(s);
    } catch (e) {
      $('edRoutineValues').textContent = e.message;
    }
  }

  $('edRoutineOpen').addEventListener('change', async () => {
    const name = $('edRoutineOpen').value;
    const hit = name && (await state.library.routines()).find((r) => r.data.name === name);
    if (!hit) return;
    $('edRoutineName').value = hit.data.name;
    for (const sel of $('edRoutinePhases').querySelectorAll('select')) sel.value = hit.data.phases[sel.dataset.phase] || '';
    $('edRoutinePalette').value = hit.data.palette || '';
    $('edRoutineBrightness').value = hit.data.shared && hit.data.shared.brightness != null ? hit.data.shared.brightness : '';
    previewRoutine();
  });
  $('edRoutinePalette').addEventListener('change', previewRoutine);
  $('edRoutineBrightness').addEventListener('input', previewRoutine);

  $('edRoutineSave').addEventListener('click', async () => {
    try {
      const lib = await ensureLibrary();
      const saved = await saveRoutine(lib, routineFromForm());
      busy(`Saved routine ${saved.name}. It now shows up as a lighting choice on the Initialise and Flash Station tabs.${lib.saved ? '' : ' Not kept after this page closes: choose a library folder.'}`);
      log(`Routine ${saved.name} (${ENGINES[ed.tag].name})`);
      await refreshLibrary();
    } catch (e) {
      busy(e.message, true);
    }
  });

  // ---------------------------------------------------------------- drive profiles
  async function refreshProfiles() {
    const profiles = state.library ? await state.library.profiles() : [];
    const sel = $('edProfileOpen');
    sel.replaceChildren(el('option', { value: '', text: 'New drive profile' }));
    profiles.forEach((p) => sel.append(el('option', { value: p.code, text: `${p.code} · ${p.family === 'pulse' ? 'Pulse' : 'Core'}` })));
    sel.value = '';
    loadProfile();
  }

  function loadProfile(family) {
    ed.profile = defaultProfile(family || ENGINES[ed.tag].family, $('edProfileCode').value || 'SOTA');
    renderProfile();
  }

  function renderProfile() {
    const p = ed.profile;
    $('edProfileFamily').value = p.family;
    $('edProfileCode').value = p.code;
    $('edProfileGroups').value = p.groups.join(', ');
    const tb = $('edProfileTable').tBodies[0];
    tb.replaceChildren();
    for (const led of p.leds) {
      const group = el('select');
      p.groups.forEach((g) => group.append(el('option', { value: g, text: g })));
      group.value = led.group;
      group.addEventListener('change', () => (led.group = group.value));
      const pos = el('input', { type: 'range', min: 0, max: 1, step: 0.05 });
      pos.value = led.position;
      const out = el('span', { class: 'sub', text: led.position.toFixed(2) });
      pos.addEventListener('input', () => {
        led.position = Number(pos.value);
        out.textContent = led.position.toFixed(2);
      });
      tb.append(el('tr', {}, el('td', { text: `LED ${led.n}` }), el('td', {}, group), el('td', { class: 'pos' }, pos, out)));
    }
  }

  $('edProfileOpen').addEventListener('change', async () => {
    const code = $('edProfileOpen').value;
    if (!code) return loadProfile($('edProfileFamily').value);
    const hit = (await state.library.profiles()).find((x) => x.code === code);
    if (hit) {
      ed.profile = structuredClone(hit);
      renderProfile();
    }
  });
  $('edProfileFamily').addEventListener('change', () => {
    ed.profile = defaultProfile($('edProfileFamily').value, $('edProfileCode').value || 'SOTA');
    renderProfile();
  });
  $('edProfileGroups').addEventListener('change', () => {
    const groups = $('edProfileGroups').value.split(',').map((g) => g.trim()).filter(Boolean);
    if (!groups.length) return;
    ed.profile.groups = groups;
    for (const l of ed.profile.leds) if (!groups.includes(l.group)) l.group = groups[0];
    renderProfile();
  });
  $('edProfileSave').addEventListener('click', async () => {
    try {
      const lib = await ensureLibrary();
      ed.profile.code = $('edProfileCode').value;
      const saved = await saveProfile(lib, { ...ed.profile, ledCount: LED_COUNT[ed.profile.family] });
      busy(`Saved drive profile ${saved.code}.${lib.saved ? '' : ' Not kept after this page closes: choose a library folder.'}`);
      log(`Drive profile ${saved.code} (${saved.family})`);
      await refreshAll();
    } catch (e) {
      busy(e.message, true);
    }
  });

  // ---------------------------------------------------------------- wiring
  async function refreshAll() {
    refreshEngineChoice();
    await refreshPhase();
    await refreshPalettes();
    await refreshRoutine();
    await refreshProfiles();
    $('edLead').textContent = state.library && state.library.saved
      ? `Saving into the folder "${state.library.name}".`
      : 'No library folder yet: what you save lasts until this page closes. Choose a folder in the Library tab to keep it.';
  }

  $('edEngine').addEventListener('change', async () => {
    ed.tag = $('edEngine').value;
    await refreshAll();
  });
  $('edPhase').addEventListener('change', refreshPhase);
  $('edPhaseFile').addEventListener('change', loadPhaseValues);
  $('edPalette').addEventListener('change', loadPalette);

  $('edPhase').replaceChildren(...PHASES.map((p) => el('option', { value: p.key, text: p.label })));
  refreshAll();
  return { refresh: refreshAll };
}
