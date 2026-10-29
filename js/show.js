// The show (roadmap R5): everything Pulse engine 2 (firmware pulsetest 2.5) plays, packed into the
// flash pages after its routine. The settings page (layout 2) says where it is, how long and its
// CRC; the bootloader doesn't check these pages, the routine does, so the drive's lighting
// fingerprint (the routine's CRC, settings page included) still changes with every animation.
//
//   the 8 LEDs' heights (2 bytes each, 0 the plug to 10000 the logo, from the drive profile)
//   4 animations, each 2 bytes of length (0 = none) then the recipe's bytes (js/player.js pack()):
//     start-up (a one-shot in ms), ambient (the loop), plug-in (on a Flash Station, until the
//     heartbeats start at 2146 ms), heartbeat (the loop on a Flash Station)
//   the song moments: a count (0-8), then each one's flags (bit 0: first time only), delay (ms,
//   2 bytes), print (2 bytes of length, js/songs.js packPrint()) and animation (2 bytes of length)
//
// DriveShow plays a show the way the engine does (its pulseBlock), for checking the firmware
// against (firmware pulsetest/tests/engine_equiv.mjs) and for previews.

import { pack, unpack, length, levels, toPixels, palette, makeDrive } from './player.js';
import * as A from './animations.js';
import * as pulse from './preview-pulse.js';
import { defaultProfile } from './profiles.js';
import { Matcher, unpackPrint } from './songs.js';

export const SHOW_ANIMS = ['startup', 'ambient', 'plugin', 'heartbeat'];
export const MAX_MOMENTS = 8;
export const PLUGIN_MS = 2146;            // the box's heartbeats start (station/patterns.h)
// The song moments demo engine (pulsetest 2.1 demo: song moments, no Flash Station plug-in) has
// room for only these moves, curves and blends, fill only from below, and 4 song moments (Jonny,
// 22 and 29 Oct 2026; the firmware's own lists: pulsetest/tools/demo_moves.mjs). 4 moments that all
// match at once take ~24 ms of a 12.8 ms block (the next block waits); 5 would lose a block.
export const DEMO_MOVES = ['glow', 'fade', 'drift', 'pulse', 'kick', 'fill'];
export const DEMO_CURVES = ['linear', 'ease', 'in', 'out'];
export const DEMO_BLENDS = ['over', 'tint', 'lift'];
export const DEMO_MAX_MOMENTS = 4;

// What recipe r uses that the demo engine hasn't got, in words ("breathe", "the exp curve", ...).
export function demoMissing(r) {
  const layers = (r.layers || []).concat(...(r.steps || []).map((x) => x.layers || []));
  return [...new Set(layers.flatMap((l) => [
    ...(DEMO_MOVES.includes(l.move) ? [] : [`"${l.move}"`]),
    ...[l.curve, l.up, l.down].filter((c) => c && !DEMO_CURVES.includes(c)).map((c) => `the ${c} curve`),
    ...(l.blend && !DEMO_BLENDS.includes(l.blend) ? [`the ${l.blend} blend`] : []),
    ...(l.move === 'fill' && l.side === 'above' ? ['fill from above'] : []),
  ]))];
}

const le16 = (n) => [n & 255, n >> 8];
const fromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));
const bytesOf = (b) => (typeof b === 'string' ? fromHex(b) : Uint8Array.from(b));

// show: { heights: [8 numbers], startup, ambient, plugin, heartbeat (recipes, or null),
//         moments: [{ print (bytes or hex), animation (recipe), delayMs, repeat: 'every' | 'first' }] }
// demo: for the song moments demo engine (only what demoMissing() allows, 4 moments; no plug-in or heartbeat).
export function packShow(show, { demo = false } = {}) {
  const out = [];
  const heights = show.heights;
  if (!Array.isArray(heights) || heights.length !== 8) throw new Error('A Pulse show needs the heights of its 8 LEDs.');
  for (const h of heights) out.push(...le16(Math.max(0, Math.min(10000, Math.round(h)))));
  const item = (b) => { if (b.length > 65535) throw new Error('Too long for the show.'); out.push(...le16(b.length), ...b); };
  // every animation is checked as a Pulse one (one for "any" board too): no hits, twinkle or flicker
  const onPulse = (r) => {
    const b = pack({ ...r, board: 'pulse' });
    if (demo) {
      const bad = demoMissing(r);
      if (bad.length) throw new Error(`"${r.name || 'This animation'}" uses ${bad.join(', ')}, which the song moments demo engine doesn't have room for. The demo plays: ${DEMO_MOVES.join(', ')} (fill from below); curves ${DEMO_CURVES.join(', ')}; blends ${DEMO_BLENDS.join(', ')}.`);
    }
    return b;
  };
  for (const k of SHOW_ANIMS) item(show[k] ? onPulse(show[k]) : []);
  if (!show.ambient) throw new Error('A show needs an ambient animation.');
  const moments = show.moments || [];
  if (moments.length > MAX_MOMENTS) throw new Error(`A Pulse can hold ${MAX_MOMENTS} song moments; this show has ${moments.length}.`);
  if (demo && moments.length > DEMO_MAX_MOMENTS) throw new Error(`The song moments demo engine takes ${DEMO_MAX_MOMENTS} song moments; this show has ${moments.length}.`);
  out.push(moments.length);
  for (const m of moments) {
    if (!(m.delayMs >= 0 && m.delayMs <= 65535)) throw new Error('A song moment\'s delay must be 0 to 65535 ms.');
    out.push(m.repeat === 'first' ? 1 : 0, ...le16(Math.round(m.delayMs)));
    item(bytesOf(m.print));
    if (!m.animation) throw new Error('Each song moment needs an animation.');
    item(onPulse(m.animation));
  }
  return Uint8Array.from(out);
}

export function unpackShow(b) {
  let i = 0;
  const u16 = () => { const v = b[i] | (b[i + 1] << 8); i += 2; return v; };
  const item = () => { const n = u16(), v = b.subarray(i, i + n); i += n; return n ? v : null; };
  const show = { heights: Array.from({ length: 8 }, u16) };
  for (const k of SHOW_ANIMS) { const v = item(); show[k] = v ? unpack(v, { name: k, board: 'pulse' }) : null; }
  const n = b[i++];
  show.moments = [];
  for (let m = 0; m < n; m++) {
    const repeat = b[i++] & 1 ? 'first' : 'every', delayMs = u16(), print = Uint8Array.from(item()), animation = unpack(item(), { name: `moment ${m + 1}`, board: 'pulse' });
    show.moments.push({ print, animation, delayMs, repeat });
  }
  if (i !== b.length) throw new Error(`The show has ${b.length - i} bytes left over.`);
  return show;
}

// Today's looks (from the engine's settings, as the Routines tab tunes them) on the default
// Pulse's real LED heights.
export function defaultShow(S = pulse.DEFAULTS, profile = defaultProfile('pulse')) {
  return {
    heights: makeDrive(profile).heights,
    startup: A.pulseStartup(S), ambient: A.pulseAmbient(S), plugin: A.pluginPulse(), heartbeat: A.heartbeat(),
    moments: [],
  };
}

// The song moments demo engine's show: a short start-up (white fading into red) and today's ambient
// look, and the song moments given ({ moment (a saved song moment: js/moments.js), animation }).
export function demoShow(moments = [], S = pulse.DEFAULTS, profile = defaultProfile('pulse')) {
  return {
    heights: makeDrive(profile).heights,
    startup: { type: 'animation', name: 'Demo start-up', board: 'pulse', timing: 'ms', once: true,
      layers: [{ move: 'fade', leds: 'all', for: 1500, colour: [3, 1], level: [0, 255], curve: 'ease' }] },
    ambient: A.pulseAmbient(S), plugin: null, heartbeat: null,
    moments: moments.map(({ moment, animation }) => ({ print: moment.print, delayMs: moment.delayMs, repeat: moment.repeat, animation })),
  };
}

// ---------------------------------------------------------------- what the drive plays
const fine = (a) => { const n = length(a); return n === null ? Infinity : a.timing === 'ms' ? Math.round(n) : Math.round(n * 16384); };
const isBeats = (a) => a.timing === 'beats';

// show: as for packShow (or unpacked); colours: { red, orange, white }.
export class DriveShow {
  constructor(show, { colours = {}, brightness = 255 } = {}) {
    const s = unpackShow(packShow(show));   // exactly what the drive has
    this.show = s;
    this.drive = { count: 8, heights: s.heights, ranks: s.heights.map((h, i) => s.heights.slice(0, i).filter((x) => x === h).length) };
    this.palette = palette(colours);
    this.brightness = brightness;
  }
  frame(anim, t, music, next) {
    const ctx = { drive: this.drive, palette: this.palette, music };
    if (next) ctx.next = (i) => levels(next, 0, { drive: this.drive, palette: this.palette, music: { ...music, kick: 0 } })[i];
    return toPixels(levels(anim, t, ctx), this.brightness);
  }
  // Off a station: the drive's LEDs at every block of a recording. st: preview-pulse stage1 (the
  // mic); S: the engine's settings (the tempo and the detectors: preview-pulse DEFAULTS' names).
  // Returns { leds: Uint8Array (24 a block), fires: [{ moment, block }], plays: [{ moment, block }],
  // run (preview-pulse stage2: the tempo grid, kicks and loudness the drive followed) }.
  run(st, S = pulse.DEFAULTS) {
    const s = this.show, startLen = s.startup ? fine(s.startup) : 0;
    const run = pulse.stage2(st, S, { startupMs: startLen }), startMs = run.startMs;
    const matcher = new Matcher(s.moments.map((m) => unpackPrint(m.print)));
    const leds = new Uint8Array(st.n * 24), fires = [], plays = [];
    let beats = 0, prevBeats = 0, ambientBeats = 0, inAmbient = false, pending = null, playing = null, fireMs = 0, momentAt = 0, played = 0;
    for (let i = 0; i < st.n; i++) {
      const now = st.now[i];
      if (i) beats = (beats + Math.floor(((now - st.now[i - 1]) >>> 0) * 1048576 / run.period[i])) >>> 0;
      const music = { bar: run.barLead[i], kick: run.kick[i], loud: run.loud[i] };
      const fired = matcher.pushBlock(st.eKick[i], st.eSnare[i], st.eAll[i], st.ok[i]) || [];
      let t = now - startMs, a = s.startup, next = s.ambient;
      if (t >= startLen) {
        if (!inAmbient) { inAmbient = true; ambientBeats = t === startLen ? beats : prevBeats; }
        for (const f of fired) fires.push({ moment: f.print, block: i });
        if (fired.length && pending === null && playing === null) {
          const f = fired.find((x) => !(played >> x.print & 1));
          if (f) { pending = f.print; fireMs = now; if (s.moments[f.print].repeat === 'first') played |= 1 << f.print; }
        }
        if (pending !== null && now - fireMs >= s.moments[pending].delayMs) {
          playing = pending; pending = null;
          momentAt = isBeats(s.moments[playing].animation) ? beats : now;
          plays.push({ moment: playing, block: i });
        }
        a = next; next = null;
        t = isBeats(a) ? (beats - ambientBeats) >>> 0 : t - startLen;
        if (playing !== null) {
          const m = s.moments[playing].animation, mt = ((isBeats(m) ? beats : now) - momentAt) >>> 0;
          if (mt < fine(m)) { next = a; a = m; t = mt; } else playing = null;
        }
      }
      const px = this.frame(a, t, music, next);
      for (let k = 0; k < 8; k++) leds.set(px[k], i * 24 + k * 3);
      prevBeats = beats;
    }
    return { leds, fires, plays, run };
  }
  // On a Flash Station: the drive's LEDs at box time t (ms after it went in).
  station(t) {
    const s = this.show, plug = s.plugin, heart = s.heartbeat;
    return t < PLUGIN_MS ? this.frame(plug, t, { bar: 0, kick: 0, loud: 0 }, heart) : this.frame(heart, t - PLUGIN_MS, { bar: 0, kick: 0, loud: 0 }, null);
  }
}

