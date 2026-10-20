// A preview clip of an animation recipe, for a Claude Code session (roadmap R3): Jonny describes
// an animation, Claude writes the recipe, runs this, and sends him the .mp4. It opens the app in
// headless Chromium, pastes the recipe into the Routines tab's Animation lab, steps the lab's
// clock frame by frame and films the drive drawing and its timeline. Needs Playwright (with
// Chromium) and ffmpeg; not part of `npm test`. Usage:
//
//   node tools/animation-clip.mjs recipe.json [--out clip.mp4] [--colours "red=255,0,0 orange=255,45,0 white=255,235,200"]
//        [--music steady|demo|song.mp3] [--start 88] [--bpm 174] [--room club] [--then builtin] [--fps 20] [--seconds 12]
//
// The recipe file can be the recipe alone or a chat message with it in a ```json block. Colours:
// a palette .json from the library (palettes/) or slots as "name=r,g,b" (red, orange, white,
// yellow); left out, the lab's own colours are used. Music is for beat-timed recipes: a steady
// beat (default), the demo track, or a song clip (never commit clips) from --start seconds; the
// clip's sound goes in the .mp4. Writes the .mp4 and a .png still next to it.

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecipe, describe } from '../js/lab.js';
import * as pulse from '../js/preview-pulse.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args.splice(i, 2)[1]; };
const out = resolve(opt('--out', 'animation-clip.mp4'));
const colourArg = opt('--colours', null), music = opt('--music', 'steady'), start = opt('--start', '0');
const bpm = opt('--bpm', '174'), room = opt('--room', 'club'), then = opt('--then', null);
const fps = Number(opt('--fps', '20')), seconds = opt('--seconds', null);
if (!args[0]) { console.error('Give a recipe file: node tools/animation-clip.mjs recipe.json'); process.exit(1); }
const text = readFileSync(args[0], 'utf8');

// Check the recipe here first: a bad one gets the lab's plain error, with no browser needed.
let checked;
try { checked = readRecipe(text); } catch (e) { console.error(`Recipe: ${e.message}`); process.exit(1); }
console.log(`${checked.recipe.name || 'Untitled'}: ${describe(checked.anim, checked.bytes)}`);
for (const w of checked.warnings) console.log(`Check: ${w}`);

function readColours(arg) {
  if (!arg) return null;
  if (existsSync(arg)) { const p = JSON.parse(readFileSync(arg, 'utf8')); return p.colours || p; }
  const set = {};
  for (const part of arg.split(/\s+/).filter(Boolean)) {
    const [k, v] = part.split('=');
    const rgb = v && v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : (v || '').split(',').map(Number);
    if (!['red', 'orange', 'white', 'yellow'].includes(k) || rgb.length !== 3 || rgb.some((x) => !(x >= 0 && x <= 255))) {
      console.error(`--colours: "${part}" should be like red=255,0,0 or red=#ff0000 (slots: red, orange, white, yellow).`);
      process.exit(1);
    }
    set[k] = rgb;
  }
  return set;
}
const colours = readColours(colourArg);

// ---------------------------------------------------------------- the app, served from this folder
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = readFileSync(path.endsWith('/') ? join(path, 'index.html') : path);
    res.writeHead(200, { 'content-type': TYPES[extname(path) || '.html'] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

function playwright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch {}
  return createRequire(join(execSync('npm root -g').toString().trim(), 'x'))('playwright');
}
const { chromium } = playwright();
const browser = await chromium.launch().catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }));
const tmp = mkdtempSync(join(tmpdir(), 'synapto-clip-'));
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.click('#t-routines');
  await page.fill('#labText', text);
  await page.evaluate(() => window.synaptoLab.read());
  if (!(await page.evaluate(() => window.synaptoLab.ok()))) throw new Error(`The lab says: ${await page.evaluate(() => window.synaptoLab.message())}`);
  if (colours) await page.evaluate((c) => window.synaptoLab.colours(c), colours);
  if (then) {
    const value = await page.$eval('#labThen', (s, want) => ([...s.options].find((o) => o.value === want || o.textContent.toLowerCase().startsWith(want.toLowerCase())) || {}).value, then);
    if (value === undefined) throw new Error(`--then: no "${then}" (try builtin). Then is only for one-shots timed in ms.`);
    await page.selectOption('#labThen', value);
  }
  if (await page.isVisible('#labMusicRow')) {
    const kind = music === 'steady' || music === 'demo' ? music : 'clip';
    await page.selectOption('#labMusic', kind);
    if (kind === 'steady') { await page.fill('#labBpm', String(bpm)); await page.dispatchEvent('#labBpm', 'change'); }
    else {
      if (kind === 'clip') { await page.setInputFiles('#labClip', resolve(music)); await page.waitForFunction(() => !/^Reading/.test(document.getElementById('labMusicNote').textContent)); await page.evaluate(() => window.synaptoLab.settled()); }
      await page.selectOption('#labRoom', room);
      await page.fill('#labStart', String(start)); await page.dispatchEvent('#labStart', 'change');
    }
    console.log(`Music: ${await page.textContent('#labMusicNote')}`);
  } else if (music !== 'steady') console.log('Music: not used (the recipe is timed in ms).');

  // film the drive and the timeline, without the controls
  await page.addStyleTag({ content: '#labScrub, .lab-play { display: none !important; } .lab-view { padding: 12px; background: var(--smoke); }' });
  const span = await page.evaluate(() => window.synaptoLab.span());
  const len = Math.min(span, seconds ? Number(seconds) * 1000 : span);
  const view = await page.$('#labView');
  await view.scrollIntoViewIfNeeded();
  const box = await view.boundingBox();
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width / 2) * 2, height: Math.floor(box.height / 2) * 2 };
  const frames = Math.max(1, Math.ceil(len / 1000 * fps));
  for (let k = 0; k < frames; k++) {
    await page.evaluate((ms) => window.synaptoLab.at(ms), (k * 1000) / fps);
    await page.screenshot({ path: join(tmp, `f${String(k).padStart(5, '0')}.png`), clip });
  }
  await page.evaluate((ms) => window.synaptoLab.at(ms), len / 3);
  const still = out.replace(/\.mp4$/i, '') + '.png';
  await page.screenshot({ path: still, clip });
  if (errors.length) throw new Error(`The page reported: ${errors.join('; ')}`);

  // the sound: the demo track (made here, as the lab makes it) or the song clip, from Start at
  let sound = null;
  if (music !== 'steady' && checked.anim.timing === 'beats') {
    if (music === 'demo') {
      const rate = 22050, a = pulse.synthDnb(rate, { bars: 46 }).audio, wav = Buffer.alloc(44 + a.length * 2);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + a.length * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(a.length * 2, 40);
      for (let i = 0; i < a.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, a[i])) * 32767), 44 + i * 2);
      sound = join(tmp, 'demo.wav');
      writeFileSync(sound, wav);
    } else sound = resolve(music);
  }
  const ff = ['-v', 'error', '-y', '-framerate', String(fps), '-i', join(tmp, 'f%05d.png')];
  if (sound) ff.push('-ss', String(start), '-i', sound, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  ff.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out);
  try { execFileSync('ffmpeg', ff); } catch (e) { throw new Error(`ffmpeg failed (is it installed?): ${e.message}`); }
  console.log(`Wrote ${out} (${(len / 1000).toFixed(1)} s, ${frames} frames${sound ? ', with sound' : ''}) and ${still}.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
