// The animation player (R2): recipes pack and unpack, fit the drives, and the rebuilt looks
// match today's preview maths (js/preview-core.js, js/preview-pulse.js, the plug-in preview).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/player.js';
import * as A from '../js/animations.js';
import * as core from '../js/preview-core.js';
import * as pulse from '../js/preview-pulse.js';
import { defaultProfile } from '../js/profiles.js';

const RECIPES = [A.coreEngine(), A.coreDrift(), A.pulseStartup(), A.pulseAmbient(), A.heartbeat()];
const CORE_ROOM = 98; // Core's settings block without its tag: recipes + 4 colours + brightness + layout byte

// The biggest difference in any colour channel between two frames, over the LEDs listed.
const diff = (a, b, leds = a.map((_, i) => i)) => Math.max(...leds.flatMap((i) => a[i].map((v, j) => Math.abs(v - b[i][j]))));

test('every recipe packs, unpacks to the same recipe and packs to the same bytes', (t) => {
  for (const r of RECIPES) {
    const bytes = P.pack(r);
    const back = P.unpack(bytes, { name: r.name, board: r.board });
    assert.deepEqual(back, P.normalise(r), r.name);
    assert.deepEqual(P.pack(back), bytes, r.name);
    t.diagnostic(`${r.name}: ${bytes.length} bytes`);
  }
});

test('Engine + Drift fit in Core\'s settings room with the colours', (t) => {
  const used = P.pack(A.coreEngine()).length + P.pack(A.coreDrift()).length + 4 * 3 + 1 + 1;
  t.diagnostic(`Core routine: ${used} of ${CORE_ROOM} bytes`);
  assert.ok(used <= CORE_ROOM, `${used} bytes`);
});

test('a step list is the same as the layers with their own times', () => {
  const steps = { once: true, steps: [{ for: 500, layers: [{ move: 'glow', level: 100 }] }, { for: 300, layers: [{ move: 'glow', level: 200 }] }] };
  const flat = { once: true, layers: [{ move: 'glow', for: 500, level: 100 }, { move: 'glow', at: 500, for: 300, level: 200 }] };
  assert.deepEqual(P.pack(steps), P.pack(flat));
  assert.equal(P.length(P.normalise(steps)), 800);
});

test('Core: Engine then Drift looks like today\'s Core preview', (t) => {
  const S = core.DEFAULTS;
  const show = new P.Show({ sections: [A.coreEngine(), A.coreDrift()], drive: P.sectionDrive('core'), colours: { red: S.RED, orange: S.ORANGE, white: S.WHITE, yellow: S.YELLOW } });
  let worst = 0;
  for (let ms = 0; ms < 25000; ms += 10) worst = Math.max(worst, diff(show.frame(ms), core.render(S, ms)));
  t.diagnostic(`biggest difference over 25 s: ${worst} of 255`);
  assert.ok(worst <= 4, `${worst}`);
});

test('Core: tuned settings still match', () => {
  const S = structuredClone(core.DEFAULTS);
  Object.assign(S, { WHITE_MS: 1500, BREATHE_MS: 3000, BREATHE_MIN: 30, COLOUR_STEP_MS: 2000, BRIGHTNESS: 200 });
  const show = new P.Show({ sections: [A.coreEngine(S), A.coreDrift(S)], drive: P.sectionDrive('core'), colours: { red: S.RED, orange: S.ORANGE, white: S.WHITE, yellow: S.YELLOW }, brightness: S.BRIGHTNESS });
  let worst = 0;
  for (let ms = 0; ms < 15000; ms += 10) worst = Math.max(worst, diff(show.frame(ms), core.render(S, ms)));
  assert.ok(worst <= 4, `${worst}`);
});

test('Pulse: start-up then ambient looks like today\'s Pulse preview on the demo track', (t) => {
  const demo = pulse.synthDnb(8000, { bars: 26 });
  const st = pulse.stage1(pulse.micVolts(demo.audio, 8000, 'club', 1, 7), 8000);
  const run = pulse.stage2(st, pulse.DEFAULTS), S = pulse.DEFAULTS;
  const show = new P.Show({ sections: [A.pulseStartup(), A.pulseAmbient()], drive: P.sectionDrive('pulse'), colours: { red: S.red, orange: S.orange, white: S.white }, music: A.pulseMusic(run, st) });
  const FRONT = [0, 1, 2, 4]; // LEDs 1, 2, 3, 5: the side the Routines tab draws
  const r = { start: [0, 0], ambient: [0, 0], back: 0 };
  for (let i = 0; i < st.n; i++) {
    const ms = st.now[i] - run.startMs, today = [];
    for (let k = 0; k < 8; k++) today.push([...run.leds.subarray(i * 24 + k * 3, i * 24 + k * 3 + 3)]);
    const mine = show.frame(ms), d = diff(mine, today, FRONT), part = ms < 9000 ? r.start : r.ambient;
    part[0] = Math.max(part[0], d); part[1] += d;
    if (ms >= 9000) r.back = Math.max(r.back, diff(mine, today));
  }
  const blocks = st.n, startBlocks = Math.round(9000 / 13);
  t.diagnostic(`front LEDs, start-up: biggest ${r.start[0]}, average ${(r.start[1] / startBlocks).toFixed(1)}; ambient: biggest ${r.ambient[0]}, average ${(r.ambient[1] / (blocks - startBlocks)).toFixed(2)}; ambient, all 8 LEDs: biggest ${r.back}`);
  assert.ok(r.start[0] <= 30 && r.start[1] / startBlocks <= 2, 'start-up');
  assert.ok(r.ambient[0] <= 3 && r.back <= 3, 'ambient');
});

test('Heartbeat looks like the plug-in preview', (t) => {
  const drive = P.sectionDrive('pulse');
  const show = new P.Show({ sections: [A.heartbeat()], drive });
  let worst = 0, sum = 0, n = 0;
  for (let ms = 0; ms < 2 * 38600; ms += 10) {
    const d = diff(show.frame(ms), A.heartbeatToday(ms, drive.heights));
    worst = Math.max(worst, d); sum += d; n++;
  }
  t.diagnostic(`biggest ${worst}, average ${(sum / n).toFixed(1)} (the preview's sparkle isn't in the recipe)`);
  assert.ok(worst <= 20 && sum / n <= 3, `${worst} ${sum / n}`);
});

test('drive profile: LEDs on the back take the height of the LED they face', () => {
  const d = P.makeDrive(defaultProfile('pulse'));
  assert.deepEqual(d.heights, [0, 0, 7292, 7292, 10000, 10000, 0, 0]);
  assert.deepEqual(d.ranks, [0, 1, 0, 1, 0, 1, 2, 3]);
  assert.deepEqual(P.makeDrive(defaultProfile('core')).heights, [0, 0, 10000, 10000, 0, 0]);
});

test('a wave travels from the plug to the logo using the profile\'s heights', () => {
  const r = { once: true, layers: [{ move: 'wave', for: 1000, from: 0, to: 100, width: 20, curve: 'linear', colour: 3 }] };
  const show = new P.Show({ sections: [r], drive: P.makeDrive(defaultProfile('pulse')) });
  const lit = (ms) => show.levels(ms).map((x) => x.l);
  assert.equal(lit(0)[0], 255); assert.equal(lit(0)[4], 0);       // at the plug
  assert.ok(lit(729)[2] >= 250 && lit(400)[2] === 0);             // the middle LED is 73% up
  assert.ok(lit(999)[4] >= 245); assert.equal(lit(999)[0], 0);
});

test('beat-timed pulses follow the bar, not the clock', () => {
  const r = { timing: 'beats', layers: [{ move: 'pulse', every: 4, rise: 0, fall: 2, up: 'linear', down: 'linear', low: 0, high: 255 }] };
  const show = new P.Show({ sections: [r], drive: P.sectionDrive('pulse'), music: () => ({ bar: 0, beats: 12345, kick: 0, loud: 0 }) });
  assert.equal(show.levels(5000)[0].l, 255);
  const half = new P.Show({ sections: [r], drive: P.sectionDrive('pulse'), music: () => ({ bar: 16384, beats: 0, kick: 0, loud: 0 }) });
  assert.equal(half.levels(0)[0].l, 128); // half way down, half way through the bar
});

test('twinkle and flicker stay between low and high and repeat the same way', () => {
  for (const move of ['twinkle', 'flicker']) {
    const r = { layers: [{ move, every: 200, low: 20, high: 200, colour: 3 }] };
    const a = new P.Show({ sections: [r], drive: P.sectionDrive('pulse') }), b = new P.Show({ sections: [r], drive: P.sectionDrive('pulse') });
    for (let ms = 0; ms < 5000; ms += 30) {
      const la = a.levels(ms).map((x) => x.l);
      assert.deepEqual(la, b.levels(ms).map((x) => x.l));
      assert.ok(la.every((v) => v >= 20 && v <= 200), `${move} ${la}`);
    }
  }
});

test('a bad recipe gets a plain error saying what to fix', () => {
  const bad = (r, re) => assert.throws(() => P.pack(r), re);
  bad({ layers: [{ move: 'spin' }] }, /Layer 1 \(spin\): unknown move "spin"/);
  bad({ layers: [{ move: 'breathe' }] }, /Layer 1 \(breathe\): "every" is needed/);
  bad({ layers: [{ move: 'glow', leds: [9] }] }, /LED 9 isn't on the board/);
  bad({ board: 'core', layers: [{ move: 'glow', leds: [7] }] }, /LED 7 isn't on the board \(1 to 6\)/);
  bad({ layers: [{ move: 'fade', level: [0, 255] }] }, /needs a length/);
  bad({ layers: [{ move: 'kick' }] }, /timing must be "beats"/);
  bad({ layers: [{ move: 'glow', colour: 6 }] }, /Layer 1 \(glow\): colour 6 is one of the recipe's own colours \(6 to 15\), but the recipe has none\. Add "custom"/);
  bad({ layers: [{ move: 'glow', colour: 16 }] }, /"colour" must be a whole number from 0 to 15 \(got 16\)/);
  bad({ layers: [{ move: 'glow', speed: 3 }] }, /"speed" isn't a setting of "glow"/);
  bad({ once: true, layers: [{ move: 'glow' }] }, /needs at least one layer with a length/);
  assert.throws(() => P.unpack(Uint8Array.of(2, 0, 1, 1)), /stop part way/);
});

// ---------------------------------------------------------------- the recipe's own colours
const GREEN = [159, 255, 82], BLUE = [0, 40, 255];
const OWN = { name: 'Orange to green', board: 'pulse', custom: [GREEN, BLUE], layers: [
  { move: 'glow', leds: [1, 2], colour: 2, for: 1000 },
  { move: 'fade', leds: [1, 2], at: 1000, for: 1000, colour: [2, 6], level: [255, 255], curve: 'linear' },
  { move: 'drift', leds: [3, 4], colours: [6, 1, 7], every: 500 },
  { move: 'glow', leds: [5, 6, 7, 8], colour: 7 }] };

test('custom colours: a count byte and 3 bytes each after the header, and back', () => {
  const bytes = P.pack(OWN), plain = P.pack({ ...OWN, custom: undefined, layers: OWN.layers.map((l) => (l.colours ? { ...l, colours: [3, 1, 2] } : { ...l, colour: Array.isArray(l.colour) ? [2, 3] : l.colour === 7 ? 3 : l.colour })) });
  assert.equal(bytes[0] & 64, 64);
  assert.equal(plain[0] & 64, 0);
  assert.deepEqual([...bytes.slice(1, 8)], [2, ...GREEN, ...BLUE]);
  assert.equal(bytes.length, plain.length + 1 + 2 * 3);
  const back = P.unpack(bytes, { name: OWN.name, board: OWN.board });
  assert.deepEqual(back, P.normalise(OWN));
  assert.deepEqual(back.custom, [GREEN, BLUE]);
  assert.deepEqual(P.pack(back), bytes);
  // an empty list is the same as none, and recipes without any are byte for byte as before
  assert.deepEqual(P.pack({ ...OWN, custom: [], layers: [{ move: 'glow' }] }), P.pack({ layers: [{ move: 'glow' }] }));
  for (const r of RECIPES) assert.equal(P.pack(r)[0] & 64, 0, r.name);
  assert.throws(() => P.unpack(Uint8Array.of(64 | 1, 11)), /1 to 10/);
  assert.throws(() => P.unpack(Uint8Array.of(64 | 1, 2, 1, 2, 3)), /stop part way/);
});

test('custom colours play as fixed RGB with any colour set, next to the set\'s own slots', () => {
  const drive = P.sectionDrive('pulse');
  for (const colours of [{}, { red: [10, 20, 30], orange: [200, 100, 0], white: [9, 9, 9] }]) {
    const show = new P.Show({ sections: [OWN], drive, colours }), pal = P.palette(colours);
    const at = (ms) => show.levels(ms);
    assert.deepEqual(at(500)[0].c, pal[2], 'orange from the set');
    assert.deepEqual(at(1999)[0].c.map((v, j) => Math.abs(v - GREEN[j]) <= 1), [true, true, true], 'fades to the fixed green');
    assert.deepEqual(at(0)[2].c, GREEN, 'drift starts on colour 6');
    assert.deepEqual(at(500)[2].c, pal[1], 'then the set\'s red');
    assert.deepEqual(at(1000)[2].c, BLUE, 'then colour 7');
    for (let i = 4; i < 8; i++) assert.deepEqual(at(100)[i].c, BLUE);
  }
});

test('each section of a show uses its own custom colours', () => {
  const first = { once: true, custom: [BLUE], layers: [{ move: 'glow', colour: 6, for: 500 }] };
  const loop = { custom: [GREEN], layers: [{ move: 'glow', colour: 6 }] };
  const show = new P.Show({ sections: [first, loop], drive: P.sectionDrive('core') });
  assert.deepEqual(show.levels(100)[0].c, BLUE);
  assert.deepEqual(show.levels(600)[0].c, GREEN);
});

test('custom colours: a bad list gets a plain error', () => {
  const bad = (r, re) => assert.throws(() => P.pack(r), re);
  bad({ custom: [GREEN], layers: [{ move: 'glow', colour: 7 }] }, /colour 7 isn't one of this recipe's own colours: its "custom" list has 1 \(colour 6\)/);
  bad({ custom: [GREEN, BLUE], layers: [{ move: 'drift', colours: [1, 8], every: 100 }] }, /colour 8 isn't one.*has 2 \(colours 6 to 7\)/);
  bad({ custom: Array(11).fill(GREEN), layers: [{ move: 'glow' }] }, /"custom" has 11 colours; the most is 10 \(colours 6 to 15\)/);
  bad({ custom: [GREEN, [300, 0, 0]], layers: [{ move: 'glow' }] }, /custom colour 2 \(colour 7\) must be \[red, green, blue\], each a whole number from 0 to 255/);
  bad({ custom: [[1, 2]], layers: [{ move: 'glow' }] }, /custom colour 1 \(colour 6\) must be \[red, green, blue\]/);
  bad({ custom: GREEN, layers: [{ move: 'glow' }] }, /custom colour 1 \(colour 6\) must be/);
  bad({ custom: { 6: GREEN }, layers: [{ move: 'glow' }] }, /"custom" is a list of the recipe's own colours in square brackets/);
  bad({ colours: [GREEN], layers: [{ move: 'glow' }] }, /"colours" isn't part of a recipe \(did you mean "custom"\?\)/);
});
