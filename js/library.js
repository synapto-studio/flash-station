// The library: a folder on your computer holding engines, phase files, routines and the
// drive register. Chrome reads and writes it directly (File System Access API) after you
// pick it once. Nothing in it is ever uploaded.
//
//   engines/    .hex files (any names; recognised by the tag inside)
//   phases/     phase files (.json)
//   routines/   routines (.json)
//   palettes/   saved colour sets (.json)
//   drives/     the drive register, one .json per drive (P-0007.json)
//   casings/    CAD models and LED positions (Stage 2)

import { parseHex } from './intelhex.js';
import { readEngine } from './engines.js';
import { isPalette, paletteFileName } from './palettes.js';

export const FOLDERS = ['engines', 'phases', 'routines', 'palettes', 'drives', 'casings'];

// ---------------------------------------------------------------- storage backends
class FolderStore {
  constructor(handle) {
    this.handle = handle;
    this.name = handle.name;
    this.kind = 'folder';
  }
  async dir(name, create = true) {
    return this.handle.getDirectoryHandle(name, { create });
  }
  async list(dirName) {
    const out = [];
    const d = await this.dir(dirName);
    for await (const [name, h] of d.entries()) if (h.kind === 'file' && !name.startsWith('.')) out.push(name);
    return out.sort();
  }
  async read(dirName, name) {
    const f = await (await (await this.dir(dirName)).getFileHandle(name)).getFile();
    return f.text();
  }
  async write(dirName, name, text) {
    const fh = await (await this.dir(dirName)).getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async ensure() {
    for (const f of FOLDERS) await this.dir(f);
  }
}

export class MemoryStore {
  constructor(name = 'Demo library (not saved)') {
    this.name = name;
    this.kind = 'memory';
    this.files = new Map();
  }
  async list(dirName) {
    return [...this.files.keys()].filter((k) => k.startsWith(dirName + '/')).map((k) => k.slice(dirName.length + 1)).sort();
  }
  async read(dirName, name) {
    const k = `${dirName}/${name}`;
    if (!this.files.has(k)) throw new Error(`${k} not found`);
    return this.files.get(k);
  }
  async write(dirName, name, text) {
    this.files.set(`${dirName}/${name}`, text);
  }
  async ensure() {}
}

// ---------------------------------------------------------------- remembering the folder
const DB = 'flash-station', STORE = 'handles';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}
async function idbSet(key, value) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, key);
      t.oncomplete = res;
      t.onerror = res;
    });
  } catch {}
}

export const folderAccessSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// Returns { store, needsPermission } for the folder picked last time, or null.
export async function rememberedFolder() {
  if (!folderAccessSupported()) return null;
  const handle = await idbGet('library');
  if (!handle) return null;
  const state = await handle.queryPermission({ mode: 'readwrite' });
  return { handle, store: new FolderStore(handle), needsPermission: state !== 'granted' };
}

// Must be called from a click.
export async function reconnectFolder(handle) {
  const state = await handle.requestPermission({ mode: 'readwrite' });
  if (state !== 'granted') throw new Error('Chrome needs permission to use the library folder.');
  const store = new FolderStore(handle);
  await store.ensure();
  return store;
}

// Must be called from a click.
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'synapto-library', mode: 'readwrite' });
  await idbSet('library', handle);
  const store = new FolderStore(handle);
  await store.ensure();
  return store;
}

// ---------------------------------------------------------------- the library itself
export class Library {
  constructor(store) {
    this.store = store;
  }

  get name() {
    return this.store.name;
  }
  get saved() {
    return this.store.kind === 'folder';
  }

  async engines() {
    const out = [];
    for (const name of await this.store.list('engines')) {
      if (!/\.hex$/i.test(name)) continue;
      try {
        out.push(readEngine(parseHex(await this.store.read('engines', name)), name));
      } catch (e) {
        out.push({ kind: 'unknown', label: `Unreadable: ${e.message}`, fileName: name });
      }
    }
    return out;
  }

  async addEngine(name, text) {
    const engine = readEngine(parseHex(text), name); // throws if it isn't a .hex at all
    await this.store.write('engines', name, text);
    return engine;
  }

  async readJson(dir, name) {
    return JSON.parse(await this.store.read(dir, name));
  }

  async writeJson(dir, name, obj) {
    await this.store.write(dir, name, JSON.stringify(obj, null, 2) + '\n');
  }

  async jsonFiles(dir) {
    const out = [];
    for (const name of await this.store.list(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push({ name, data: await this.readJson(dir, name) });
      } catch {}
    }
    return out;
  }

  async routines(family) {
    return (await this.jsonFiles('routines')).filter((r) => !family || r.data.family === family);
  }

  async phases() {
    return this.jsonFiles('phases');
  }

  // Saved colour sets for one board. Saving under an existing name replaces it.
  async palettes(family) {
    return (await this.jsonFiles('palettes')).map((f) => f.data).filter((p) => isPalette(p) && (!family || p.family === family));
  }

  async savePalette(palette) {
    if (!isPalette(palette)) throw new Error('That colour set is not complete.');
    await this.writeJson('palettes', `${palette.family}-${paletteFileName(palette.name)}`, palette);
  }

  async drives() {
    return (await this.jsonFiles('drives')).map((d) => d.data).filter((d) => d && d.drive);
  }

  async saveDrive(record) {
    await this.writeJson('drives', `${record.drive}.json`, record);
  }

  async findDrive({ chipSerial, label }) {
    const all = await this.drives();
    return all.find((d) => (label && d.drive === label) || (chipSerial && d.chipSerial === chipSerial)) || null;
  }

  async nextNumber(family) {
    const used = (await this.drives()).filter((d) => d.family === family).map((d) => d.number);
    return used.length ? Math.max(...used) + 1 : 1;
  }
}

// A routine names one phase file per phase; each phase file holds settings for that phase.
// Resolved over the engine's defaults, so a missing phase keeps the engine's own look.
export async function resolveRoutine(library, routine, engineDefaults) {
  const settings = structuredClone(engineDefaults);
  const phases = await library.phases();
  for (const [phase, ref] of Object.entries(routine.phases || {})) {
    if (!ref) continue;
    const [name, version] = String(ref).split('@');
    const matches = phases.filter((p) => p.data.name === name && p.data.phase === phase);
    const pick = version ? matches.find((p) => String(p.data.version) === version) : matches.sort((a, b) => (b.data.version || 0) - (a.data.version || 0))[0];
    if (!pick) throw new Error(`Routine ${routine.name}: phase file ${ref} (${phase}) isn't in the library.`);
    Object.assign(settings, pick.data.settings);
  }
  Object.assign(settings, routine.shared || {});
  settings.tag = engineDefaults.tag;
  settings.layout = engineDefaults.layout;
  return settings;
}
