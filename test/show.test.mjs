// Pulse engine 2 (roadmap R5): the show (js/show.js), settings layout 2 and its pages in
// js/engines.js, and sending them (js/station.js) to the simulated drive. The firmware side
// (pulsetest 2.5) is checked against DriveShow in the firmware repo (pulsetest/tests/engine_equiv.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { packSettings, unpackSettings, layoutSize, PulseImage, PULSE, readEngine, buildInitImage, initImageToMem } from '../js/engines.js';
import { crc16 } from '../js/crc.js';
import { packShow, unpackShow, defaultShow, demoShow, DriveShow, DEMO_MOVES, demoMissing, PLUGIN_MS } from '../js/show.js';
import * as P from '../js/player.js';
import * as A from '../js/animations.js';
import { patchPlan, fullPlan, Station } from '../js/station.js';
import { SimStation, SimDrive } from '../js/sim-station.js';

const SET2 = {
  tag: 'SOTA.PLS', layout: 2, brightness: 255, white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0],
  bpmX10: 1740, bpmMin: 165, bpmMax: 180, leadMs: 20, micTrimDb: 0, kickFadeMs: 160, kickMin: 90,
  kickJumpX10: 14, kickLoudX10: 15, kickMinPct: 45, kickFloorUv: 200, kickGapMs: 150,
  snareJumpX10: 16, snareLoudX10: 35, snareMinPct: 50, snareFloorUv: 20, showPage: 0, showLen: 0, showCrc: 0xffff,
};
// a made-up engine 2 routine: filler code with the layout 2 settings page in it
function app2(len = 12992) {
  let s = 7;
  const a = Uint8Array.from({ length: len }, () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff);
  a.set(packSettings('SOTA.PLS', SET2), 190 * 64);
  return a;
}

test('settings layout 2 is one 64-byte page and round-trips; layout 1 still reads', () => {
  assert.equal(layoutSize('SOTA.PLS', 2), 64);
  assert.equal(layoutSize('SOTA.PLS'), 64);
  const b = packSettings('SOTA.PLS', SET2);
  assert.deepEqual(unpackSettings('SOTA.PLS', b), SET2);
  assert.ok(!('riseMs' in unpackSettings('SOTA.PLS', b)), 'the looks are recipes now');
});

test('the show: packs, reads back, and the drive gets exactly that', () => {
  const show = defaultShow();
  const b = packShow(show);
  assert.equal(b.length, 189, 'today\'s looks: start-up 84, ambient 32, plug-in 20, heartbeat 28 bytes, plus heights and lengths');
  const back = unpackShow(b);
  assert.deepEqual(back.heights, show.heights);
  for (const k of ['startup', 'ambient', 'plugin', 'heartbeat']) assert.deepEqual(P.pack(back[k]), P.pack({ ...show[k], board: 'pulse' }), k);
  assert.deepEqual(packShow(back), b);
});

test('a Pulse can\'t have hits, twinkle or flicker; the demo only its moves, curves and blends, 4 moments', () => {
  const tw = { type: 'animation', name: 'Sparkle', board: 'pulse', timing: 'ms', layers: [{ move: 'twinkle', leds: 'all', every: 100 }] };
  assert.throws(() => P.normalise(tw), /"twinkle" isn't on a Pulse: there wasn't room for it on the Pulse's chip/);
  assert.throws(() => packShow({ ...defaultShow(), ambient: { ...tw, board: 'any' } }), /isn't on a Pulse/, 'an "any" recipe going to a Pulse too');
  assert.doesNotThrow(() => P.normalise({ ...tw, board: 'any' }), 'still fine for any other board');
  assert.deepEqual(DEMO_MOVES, ['glow', 'fade', 'drift', 'pulse', 'kick', 'fill']);   // (firmware pulsetest/tools/demo_moves.mjs)
  assert.throws(() => packShow(defaultShow(), { demo: true }), /"Pulse start-up" uses "wave", "rainbow", the mask blend, fill from above, "wipe", which the song moments demo engine doesn't have room for/);
  assert.doesNotThrow(() => packShow(demoShow(), { demo: true }));
  const one = (l) => ({ type: 'animation', name: 'One', board: 'pulse', timing: 'ms', once: true, layers: [{ leds: 'all', colour: 1, for: 500, ...l }] });
  assert.deepEqual(demoMissing(one({ move: 'breathe', every: 100 })), ['"breathe"']);
  assert.deepEqual(demoMissing(one({ move: 'fade', colour: [1, 2], curve: 'exp', blend: 'mask' })), ['the exp curve', 'the mask blend']);
  assert.deepEqual(demoMissing(one({ move: 'pulse', every: 100, fall: 50, down: 'exp' })), ['the exp curve']);
  assert.deepEqual(demoMissing(one({ move: 'fill', from: 0, to: 100, side: 'above' })), ['fill from above']);
  assert.deepEqual(demoMissing(one({ move: 'fill', from: 0, to: 100, curve: 'out', blend: 'tint' })), []);
  assert.throws(() => packShow({ ...demoShow(), ambient: one({ move: 'fade', colour: [1, 2], blend: 'mask' }) }, { demo: true }), /uses the mask blend/);
  const m = { print: new Uint8Array(96), animation: one({ move: 'glow' }), delayMs: 0, repeat: 'every' };
  assert.doesNotThrow(() => packShow({ ...demoShow(), moments: Array(4).fill(m) }, { demo: true }));
  assert.throws(() => packShow({ ...demoShow(), moments: Array(5).fill(m) }, { demo: true }), /takes 4 song moments/);
});

test('song moments in the show: print, delay, repeat and animation; at most 8', () => {
  const print = Uint8Array.from({ length: 96 }, (_, i) => i);
  const flash = { type: 'animation', name: 'Flash', board: 'pulse', timing: 'beats', once: true, custom: [[0, 255, 60]], layers: [{ move: 'pulse', leds: 'all', colour: 6, every: 1, fall: 0.5, for: 8 }] };
  const m = { print, animation: flash, delayMs: 172, repeat: 'first' };
  const b = packShow({ ...defaultShow(), moments: [m] });
  const back = unpackShow(b).moments[0];
  assert.deepEqual([...back.print], [...print]);
  assert.equal(back.delayMs, 172);
  assert.equal(back.repeat, 'first');
  assert.deepEqual(P.pack(back.animation), P.pack(flash));
  assert.throws(() => packShow({ ...defaultShow(), moments: Array(9).fill(m) }), /can hold 8 song moments/);
});

test('engine 2 image: the show goes in the pages after the routine; the settings page says where, how long, its CRC', () => {
  const show = packShow(defaultShow()), img = new PulseImage(app2(), [2, 5], null, show);
  assert.equal(img.showPage, 203);
  const set = img.settings;
  assert.deepEqual([set.showPage, set.showLen, set.showCrc], [203, 189, crc16(show)]);
  const pages = img.pages().map(([p]) => p);
  assert.deepEqual(pages.slice(-5), [202, 203, 204, 205, PULSE.TRAILER_PAGE], 'routine, show (3 pages), trailer');
  assert.throws(() => new PulseImage(app2(), [2, 5], null, new Uint8Array(300)), /come to 300 bytes; only 256 fit on the drive after this engine/);
  // the files: read back with the same show
  const boot = new Uint8Array(PULSE.APP_START).fill(0x11);
  const e = readEngine(initImageToMem(buildInitImage({ kind: 'pulsetest', app: img.app, version: [2, 5], boot, hasBootloader: true, show })), 'pulsetest_2.5_full.hex');
  assert.equal(e.layout, 2);
  assert.equal(e.label, 'pulsetest 2.5 (engine 2)');
  assert.deepEqual([...e.show], [...show]);
});

test('a settings send to engine 2 rewrites the settings page and the show, and the drive checks out', async () => {
  const before = new PulseImage(app2(), [2, 5], null, packShow(defaultShow()));
  const drive = new SimDrive(before);
  const sim = new SimStation(drive), st = new Station(sim);
  await st.connect();
  const own = { ...defaultShow(), ambient: { type: 'animation', name: 'Blue', board: 'pulse', timing: 'ms', custom: [[0, 0, 255]], layers: [{ move: 'breathe', leds: 'all', colour: 6, every: 3000 }] } };
  const after = new PulseImage(app2(), [2, 5], { ...SET2, red: [0, 255, 0] }, packShow(own));
  const plan = patchPlan(after);
  await st.run(plan);
  assert.equal(drive.valid, true);
  assert.deepEqual(drive.settings().red, [0, 255, 0]);
  const showBytes = Uint8Array.from(after.showPages().flatMap(([p]) => [...drive.pages.get(p)])).subarray(0, after.show.length);
  assert.deepEqual([...showBytes], [...after.show], 'the new show is on the drive');
  assert.equal(drive.rejected, 0);
  const t = planMs(plan);
  assert.ok(t < 30000, `${t} ms`);
  // a whole engine send still works, and has the show's pages in it
  const d2 = new SimDrive(new PulseImage(app2(13000), [2, 4], null, packShow(defaultShow())));
  const s2 = new Station(new SimStation(d2));
  await s2.connect();
  await s2.run(fullPlan(after));
  assert.equal(d2.valid, true);
});
const planMs = (plan) => plan.reduce((n, s) => n + s.bytes.length * 10000 / s.baud + s.gapMs, 0);

test('DriveShow on a Flash Station: the plug-in until 2146 ms, then the heartbeat from its start', () => {
  const d = new DriveShow(defaultShow());
  const drive = d.drive, pal = P.palette({});
  const plugin = P.normalise({ ...A.pluginPulse(), board: 'pulse' }), heart = P.normalise({ ...A.heartbeat(), board: 'pulse' });
  const ctx = { drive, palette: pal, music: { bar: 0, kick: 0, loud: 0 } };
  assert.deepEqual(d.station(500), P.toPixels(P.levels(plugin, 500, ctx)));
  assert.deepEqual(d.station(PLUGIN_MS + 1234), P.toPixels(P.levels(heart, 1234, ctx)));
  assert.equal(d.station(700)[0][0], 85, 'the drive holds the bootloader\'s listening glow (148 squared: 85)');
});
