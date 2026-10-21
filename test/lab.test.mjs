// The Animation lab (R3): a pasted recipe is read however it was copied, a bad one gets a plain
// error saying what's wrong (and where, for typing slips), and recipes save to and open from the
// library's animations/ folder. The lab on screen is checked in headless Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/lab.js';
import * as P from '../js/player.js';
import * as A from '../js/animations.js';
import { Library, MemoryStore } from '../js/library.js';
import { defaultProfile } from '../js/profiles.js';

const CLEAN = '{ "type": "animation", "name": "Glow", "board": "pulse", "layers": [ { "move": "breathe", "colour": 2, "every": 4000 } ] }';
const BUILT_IN = [A.coreEngine(), A.coreDrift(), A.pulseStartup(), A.pulseAmbient(), A.heartbeat(), A.dropExample()];

test('a recipe reads the same however it was copied from the chat', () => {
  const want = L.readRecipe(CLEAN).recipe;
  const pastes = [
    `Here's the recipe:\n\n\`\`\`json\n${CLEAN}\n\`\`\`\n\nSay "slower" if you want it slower.`,
    'Sure! { "type": "animation", "name": "Glow", "board": "pulse", "layers": [ { "move": "breathe", "colour": 2, "every": 4000 } ] } Try it in the lab.',
    '{ “type”: “animation”, “name”: “Glow”, “board”: “pulse”, “layers”: [ { “move”: “breathe”, “colour”: 2, “every”: 4000 } ] }',
    "{ type: 'animation', name: 'Glow', board: 'pulse', layers: [ { move: 'breathe', colour: 2, every: 4000, }, ], }",
    '{\n  "type": "animation", // what it is\n  "name": "Glow", "board": "pulse",\n  /* one layer */ "layers": [ { "move": "breathe", "colour": 2, "every": 4000 } ]\n}',
  ];
  for (const p of pastes) assert.deepEqual(L.readRecipe(p).recipe, want, p);
});

// [what was pasted, what the error must say, the line it must point at (typing slips only)]
const BAD = [
  ['', /^Paste a recipe first/],
  ['make it slower please', /no recipe here/],
  ['{ "name": "A",\n  "layers": [\n    { "move": "glow" "colour": 2 }\n  ] }', /^Line 3: a comma is missing before "colour"/, 3],
  ['{ "name": "A",\n  "layers": [\n    { "move": "glow", "colour": 2 },', /cut off/, 2],
  ['{ "name": "A", "layers": [ { "move": "glow" } ] } }', /extra \}/, 1],
  ['{ "name": "A", "layers": [ { "move": "glow" } ] }\n{ "name": "B" }', /second recipe/, 2],
  ['{ "name": "A", "layers": [ { "move": glow } ] }', /"glow" isn't a number, true or false\. If it's a word, put it in double quotes/, 1],
  ['{ "name": "A", "layers": [ { "move": "breathe", "every": 4s } ] }', /"4s" isn't a number/, 1],
  ['{ "name": "A", "layers": [ { "move": "glow", "colour": 1, "colour": 2 } ] }', /"colour" is given twice/, 1],
  ['{ "name": "A, "layers": [] }', /a comma is missing|colon/],
  ['{ "name": "A", "lyers": [ { "move": "glow" } ] }', /"lyers" isn't part of a recipe \(did you mean "layers"\?\)/],
  ['{ "name": "A", "layers": [ { "move": "glow", "color": 2 } ] }', /Layer 1 \(glow\): "color" isn't a setting of "glow" \(did you mean "colour"\?\)/],
  ['{ "name": "A", "layers": [ { "move": "strobe" } ] }', /unknown move "strobe" \(did you mean "pulse"\?\)/],
  ['{ "name": "A", "layers": [ { "colour": 2 } ] }', /Layer 1: it has no "move"/],
  ['{ "name": "A", "board": "core", "layers": [ { "move": "glow", "leds": [1, 7] } ] }', /LED 7 isn't on the board \(1 to 6\)/],
  ['{ "name": "A", "layers": [ { "move": "kick" } ] }', /"kick" follows the music, so the recipe's timing must be "beats"/],
  ['{ "name": "A", "layers": [ { "move": "breathe", "every": 4 } ] }', /"every" is 4, which is under one step \(10 ms\).*"timing": "beats"/],
  ['{ "name": "A", "layers": [ { "move": "fill" } ] }', /"fill" needs a length \("for"\)/],
  ['{ "name": "A", "layers": { "move": "glow" } }', /"layers" must be a list/],
  ['{ "name": "A", "once": true, "steps": [ { "for": 2, "layers": [ { "move": "glow" } ] }, { "layers": [ { "move": "glow" } ] } ] }', /^Step 2: each step needs a length/],
  ['{ "name": "A", "timing": "beats", "once": true, "steps": [ { "for": 4, "layers": [ { "move": "glow" } ] }, { "for": 2, "layers": [ { "move": "pulse", "every": 1, "rise": 1, "fall": 1 } ] } ] }', /^Step 2, layer 1 \(pulse\): "rise" and "fall" together must fit in "every"/],
  ['{ "name": "A", "layers": [ { "move": "glow" } ] , "once": true }', /one-shot animation \("once"\) needs at least one layer with a length/],
  ['{ "name": "glacier", "family": "pulse", "colours": { "white": [1, 2, 3], "red": [1, 2, 3], "orange": [1, 2, 3] } }', /This is a colour set \("glacier"\)/],
  ['{ "move": "glow", "colour": 2 }', /This is one layer\. Wrap it as a recipe/],
  ['[ { "move": "glow" } ]', /This is a list of layers/],
];

test('a bad recipe gets a plain error saying what is wrong, and where', () => {
  for (const [text, says, line] of BAD) {
    let err = null;
    try { L.readRecipe(text); } catch (e) { err = e; }
    assert.ok(err, `no error for ${text}`);
    assert.ok(err instanceof L.LabError || err instanceof L.RecipeError, `${err.message} (${err.constructor.name})`);
    assert.match(err.message, says, text);
    assert.doesNotMatch(err.message, /undefined|NaN|\[object|Unexpected token|JSON at position/, err.message);
    if (line) assert.equal(err.at && err.at.line, line, `${err.message} should point at line ${line}`);
  }
});

test('warnings: ms times that look like beats, and beat timing on a Core', () => {
  assert.match(L.readRecipe('{ "name": "A", "layers": [ { "move": "breathe", "every": 16 } ] }').warnings[0], /20 ms or less \(every 20\)/);
  assert.deepEqual(L.readRecipe('{ "name": "A", "layers": [ { "move": "breathe", "every": 30 } ] }').warnings, []);
  assert.match(L.readRecipe('{ "name": "A", "board": "core", "timing": "beats", "layers": [ { "move": "breathe", "every": 4 } ] }').warnings[0], /Core has no microphone/);
  assert.deepEqual(L.readRecipe(CLEAN).warnings, []);
});

test('every built-in recipe opens in the lab as text and reads back the same', () => {
  for (const r of BUILT_IN) {
    const back = L.readRecipe(L.recipeText(r));
    assert.deepEqual(back.anim, P.normalise(r), r.name);
    assert.equal(back.bytes, P.pack(r).length, r.name);
    assert.ok(L.describe(back.anim, back.bytes).length > 20);
  }
  assert.equal(L.describe(P.normalise(A.dropExample()), 21), 'Pulse, follows the beat, plays once, 3 bars. 2 layers, 21 bytes on the drive.');
  assert.equal(L.describe(P.normalise(A.heartbeat()), 28), 'Any board, timed in ms, loops every 38.6 s. 3 layers, 28 bytes on the drive.');
});

test('the timeline: a one-shot and a short tail, a loop repeated to fill 8 s or 8 bars', () => {
  assert.equal(L.timelineLength(P.normalise(A.dropExample())), 12 + 4);                 // 3 bars + 1
  assert.equal(L.timelineLength(P.normalise(A.coreEngine())), P.length(P.normalise(A.coreEngine())) + 1500);
  assert.equal(L.timelineLength(P.normalise(A.heartbeat())), 38600);                     // one cycle
  assert.equal(L.timelineLength(P.normalise(A.pulseAmbient())), 32);                     // 4-bar drift, twice
  assert.equal(L.timelineLength(L.readRecipe(CLEAN).anim), 8000);                        // a 4 s breathe, twice
});

test('the Drop example plays as described: white fills from the plug up, then a red strobe on each beat', () => {
  const show = new P.Show({ sections: [A.dropExample()], drive: P.makeDrive(defaultProfile('pulse')), colours: { red: [255, 0, 0], white: [255, 235, 200] } });
  const beat = 60000 / 174, lit = (px) => px.map((c) => Math.max(...c) > 40);
  // the fill: the bottom LEDs (1, 2) light before the top ones (5, 6), all white
  const early = lit(show.frame(Math.round(beat * 2.2)));
  assert.ok(early[0] && early[1] && !early[4] && !early[5], 'bottom first');
  assert.ok(lit(show.frame(Math.round(beat * 3.9))).every(Boolean), 'all lit by the end of the bar');
  // strobes: bright red just after each beat of bars 2 and 3, dark just before the next
  for (let b = 4; b < 12; b++) {
    const on = show.frame(Math.round(beat * b) + 5), off = show.frame(Math.round(beat * (b + 1)) - 15);
    assert.ok(on.every((c) => c[0] > 200 && c[1] === 0), `beat ${b} on`);
    assert.ok(off.every((c) => c[0] < 40), `beat ${b} off`);
  }
  assert.ok(show.frame(Math.round(beat * 12.5)).every((c) => Math.max(...c) === 0), 'dark after 3 bars');
});

test('a hits layer inside a step keeps its own length', () => {
  const r = { once: true, steps: [{ for: 500, layers: [{ move: 'hits', hits: [[50, 100, 255], [50, 100, 200]] }] }] };
  assert.equal(P.length(P.normalise(r)), 300);
});

test('the library saves animations in animations/, lists them by board and refuses bad ones', async () => {
  const lib = new Library(new MemoryStore());
  const drop = L.readRecipe(L.recipeText(A.dropExample())).recipe;
  const a = await lib.saveAnimation(drop, 'Drop');
  assert.equal(a.file, 'pulse-drop.json');
  assert.equal(a.replaced, false);
  assert.equal((await lib.saveAnimation(drop, '  Drop ')).replaced, true);
  await lib.saveAnimation(L.readRecipe(L.recipeText(A.heartbeat())).recipe);
  await lib.saveAnimation(L.readRecipe(L.recipeText(A.coreDrift())).recipe, 'Drift slow');
  assert.deepEqual(await lib.store.list('animations'), ['any-heartbeat.json', 'core-drift-slow.json', 'pulse-drop.json']);
  assert.deepEqual((await lib.animations('pulse')).map((x) => x.name).sort(), ['Drop', 'Heartbeat']);
  assert.deepEqual((await lib.animations('core')).map((x) => x.name).sort(), ['Drift slow', 'Heartbeat']);
  // the saved file is the recipe as written (steps stay steps), named, and reads back the same
  const text = await lib.store.read('animations', 'pulse-drop.json');
  assert.match(text, /"steps": \[/);
  const back = L.readRecipe(text);
  assert.equal(back.recipe.name, 'Drop');
  assert.deepEqual(back.anim.layers, P.normalise(A.dropExample()).layers);
  // refused, with a plain message, and nothing written
  await assert.rejects(lib.saveAnimation(drop, '   '), /Give the animation a name/);
  await assert.rejects(lib.saveAnimation({ ...drop, steps: [{ for: 4, layers: [{ move: 'wobble' }] }] }, 'Bad'), /unknown move "wobble"/);
  assert.equal((await lib.store.list('animations')).length, 3);
  // a broken file someone put in the folder is skipped, not shown
  await lib.store.write('animations', 'pulse-broken.json', '{ "type": "animation", "name": "Broken", "layers": [ { "move": "nope" } ] }');
  assert.equal((await lib.animations('pulse')).length, 2);
});
