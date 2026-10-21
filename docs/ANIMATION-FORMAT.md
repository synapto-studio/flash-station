# Animation format and player (R2)

One small **player** plays every animation. An animation is a short **recipe**: a list of layers, each one *move* on some LEDs for some time. The app's player is `js/player.js`; the firmware players (R5 Pulse, R6 Core) must match it frame for frame, so everything below is whole-number maths. Built-in recipes are in `js/animations.js`; `test/player.test.mjs` checks them.

## A recipe

```json
{ "type": "animation", "name": "Drift", "board": "core", "timing": "ms", "once": false,
  "layers": [
    { "move": "drift", "leds": [1, 2, 5, 6], "colours": [1, 4, 2], "level": 255, "every": 5000 },
    { "move": "breathe", "leds": [3, 4], "colour": 1, "low": 70, "high": 255, "every": 4000, "phase": 950 } ] }
```

| Field | Meaning |
|---|---|
| `name` | What it's called in the library (the file is `animations/<board>-<name>.json`) |
| `notes` | Optional: what it should look like, in words (not sent to the drive) |
| `board` | `core` (6 LEDs), `pulse` (8) or `any` |
| `timing` | `ms` (times in milliseconds, steps of 10) or `beats` (times in beats, steps of 1/16; a bar is 4 beats) |
| `once` | `true`: a one-shot (start-up, song moment) that ends when its last timed layer ends, then the next section plays. `false`: loops (a loop with timed layers repeats every time the last one ends) |
| `custom` | Optional: up to 10 colours of the recipe's own, `[[159, 255, 82], ...]` (red, green, blue, 0–255). The first is colour **6**, the next 7, up to 15 (see Colours below) |
| `layers` | Drawn in order: later layers go over earlier ones |
| `steps` | For one-shots, instead of (or after) `layers`: `[{ "for": 1200, "layers": [...] }, ...]`. A step's layers start when the step does and last as long as it, unless they give their own `at` (from the step's start) or `for` (may run past the step) |

**Every layer:** `move`, `leds` (`"all"` or LED numbers), `at` (when it starts, from the start of the animation; default 0), `for` (how long; left out = to the end). Each layer keeps its own time from its `at`, so a loop inside it starts at its beginning (`phase` shifts it).

**Colours** are slots in the routine's colour set, never "red": **1** red, **2** orange, **3** white, **4** yellow (Core's fourth colour; Pulse uses its orange), **5** the station box's warm white (255, 247, 234, fixed), **0** off. Any animation works with any colour set.

**Custom colours** (6–15) are fixed colours the recipe carries itself, for a colour that must look the same whatever the routine's colour set is (a song moment copied from a DJ's screen). `"custom": [[159, 255, 82]]` makes colour 6 that green; a layer uses it like any other slot (`"colour": 6`, `"colour": [2, 6]`, `"colours": [6, 1]`), so one animation can mix the set's orange with its own green. Each costs 3 bytes. Only as many as the list has can be used: `"colour": 7` with one custom colour is an error. Like every slot, they still go through the layer's level and the routine's brightness.

**Levels** are 0–255. On the way out each LED's level is squared (so dim looks dim) and then scaled by the routine's brightness, as both engines do today: `k = level² / 255 × brightness / 255`, `rgb = colour × k / 255`.

**Where on the drive:** each LED has a height from the plug (0 %) to the logo (100 %), from the drive profile (`casings/*.json`): 0 % is the lowest LED, 100 % the highest. LEDs on the back take the height of the front LED they face (Core 4→3, 5→1, 6→2; Pulse 4→3, 6→5, 7→1, 8→2). Positions in recipes are % of the drive (even numbers, −256 to 254: a wave can start below the plug, in the box), widths are whole %.

**Curves:** `linear`, `ease` (slow, fast, slow), `in` (starts slow), `out` (starts fast), `exp` (a heartbeat's fade). Rising: `curve(x)`; falling: `255 − curve(x)`.

**Blends** (how a layer goes over the ones before it): `over` (sets colour and level), `mask` (only lets through its level: dims what's below), `tint` (mixes what's below towards its colour, keeps the level), `lift` (raises what's below towards full, keeps the colour).

## The moves

| Move | Settings (default) | What it does |
|---|---|---|
| `glow` | colour (1), level (255) | Steady |
| `fade` | colour `[from, to]`, level `[from, to]`, curve (ease), blend (over); needs `for` | Colour and level change over the layer's length |
| `breathe` | colour, low (0), high (255), every, phase (0) | Starts at high, eases to low and back once per `every` |
| `drift` | colours (2–4 slots), level, every, phase | Eases from each colour to the next, `every` per change, back to the first |
| `pulse` | colour, low, high, every, rise (0), fall, up (ease), down (ease), lag (0), blend | One pulse per `every`: rises over `rise`, falls over `fall`, then rests at low. In beats, an `every` that fits a bar (1/16 … 4 beats) locks to the bar's downbeat. `lag`: how much later it reaches the logo (+, spreads up from the plug) or the plug (−, spreads down) |
| `hits` | colour, fadeTo (85), hits `[[on, off, peak], ...]` (on/off in steps of 5 ms) | A list of strikes: each jumps to its peak, fades to peak × fadeTo / 255 over `on`, then dark for `off`. Its length is the hits' total (Core's motor cranks) |
| `wave` | colour, low, high, from (0), to (100), width, curve, round (false), land (false), back (false), blend; needs `for` | A glow travels from → to: `high` at its centre, falling to `low` over `width` (straight, or `round`ed). `back`: there and back. `land`: it comes to rest in the LEDs at the end it travels to |
| `fill` | colour, level, from, to, edge (20), curve, side (below), blend; needs `for` | A front moves from → to with a soft edge `edge` wide; LEDs on `side` of it are lit. As a `mask` it pours or drains what's below |
| `wipe` | colour, level, from, to, crest (15), behind (40), curve; needs `for` | A crest of colour sweeps from → to and leaves the **next section** behind it (crossfading over `behind`); dark ahead of it. The next section is held at its first frame (beat moves keep time; kicks wait until it's on) |
| `rainbow` | level, every, phase, lag, twist (0) | Colour wheel turning once per `every`; `twist` turns each LED at the same height a little further |
| `kick` | loud (85 dB) | Beats only: lifts towards full on each kick, once the music is at least `loud` dB there (0 at loud − 3 dB, full at loud) |
| `twinkle` | colour, low, high, every, chance (64) | Each LED, each `every`, sparkles with chance/256 |
| `flicker` | colour, low, high, every | Each LED eases to a new random level between low and high every `every` |

A "flash" is a `pulse` with a short rise and fall; a "strobe on every beat for 2 bars" is `pulse` with `every: 1`, `for: 8`.

## Bytes

Packed by `pack()` and read by `unpack()`; the name and board are kept outside the bytes.

- **Header, 1 byte:** bits 0–3 number of layers (1–15), bit 4 timing in beats, bit 5 one-shot, bit 6 it has custom colours (bit 7 is unused, 0).
- **Custom colours,** only if bit 6: a count byte (1–10), then 3 bytes (red, green, blue) for each, colour 6 first. A recipe without them has no extra bytes, so today's recipes are unchanged.
- **Each layer:** 1 byte: bits 0–3 the move's number (table order above: glow 0 … flicker 12), bits 4–5 when it starts (0 at the start, 1 when the layer before ends, 2 with the layer before, 3 at a time given next), bit 6 it has a length, bit 7 same LEDs as the layer before. Then the LED byte (bit 0 = LED 1) unless bit 7, the start time if 3, the length if bit 6, then the move's settings in the order of the table.
- **A time** is 1 byte `0xxxxxxx` (0–127 units) or 2 bytes `1xxxxxxx xxxxxxxx` (up to 32,767 units). Units: 10 ms, or 1/16 beat. `lag` is 1 signed byte of the same units.
- **Other settings:** colour (a slot, 0–15), level, % width, loud, chance, twist: 1 byte. `fade`'s colours: 1 byte (from in the high 4 bits). `drift`'s colours: 2 bytes, 4 slots of 4 bits, 0 = unused. Levels `[from, to]`: 2 bytes. Positions: 1 signed byte = % / 2. Hits: a count, then on, off (5 ms units), peak.
- **Style byte** (last, for the moves that have one), from bit 0: `fade` blend (2 bits), curve (3); `pulse` up (3), down (3), blend (2); `wave` curve (3), round, land, back (1 each), blend (2); `fill` curve (3), side (1: 0 above, 1 below), blend (2); `wipe` curve (3). Curves: 0 linear, 1 ease, 2 in, 3 out, 4 exp. Blends: 0 over, 1 mask, 2 tint, 3 lift.

## Rules for a firmware player (R5, R6)

- Time inside the player: whole ms, or for beat-timed animations 1/65,536 of a bar (a recipe's 1/16 beat × 1024). The beat clock comes from the drive's tempo grid: the bar's phase (shown `leadMs` early) for locked pulses, and a smooth count of bars since the section started for everything else.
- `ease(x) = x·x·(765 − 2x) / 65025`; progress through a length is `t × 255 / len`; `mix(a, b, k) = (a(255 − k) + b·k) / 255`; going down, `a − (a − b)·k / 255` (never divide a negative number). The `exp` curve is the 24-entry table in `js/player.js` (exp(−x) in quarters, as the plug-in animation in pulsetest 1.5+).
- Heights are 0–10,000 from the plug; recipe positions × 100.
- Colour slots: 0–5 from the routine's colour set, 6–15 from the playing animation's own custom colours. Each section uses its own: a start-up's colour 6 and the ambient's colour 6 can be different colours.
- Check against `js/player.js` frame for frame, like `run_equiv.js` does for today's routine.

## Making an animation in a session (the Animation lab, R3)

Jonny describes the animation in a Claude Code session ("on the drop: white fill from the plug up, then red strobes on every beat for 2 bars"). Claude:

1. Writes the recipe to a file in the scratchpad, using the moves above. Say in `notes` what it should look like. Times are ms unless `"timing": "beats"`; music-following ones (Pulse only) are in beats, 4 to a bar.
2. Makes a preview clip: `node tools/animation-clip.mjs recipe.json --out drop.mp4` (add `--music demo --start 8` for a beat-timed one, `--colours "red=0,70,255 orange=0,255,230 white=190,235,255"` for a colour set: the named Pulse sets are in the firmware repo's `pulsetest/colour_sets.py`, as white, red, orange; `--then builtin` to see a start-up run into the ambient look). It checks the recipe first and prints the lab's plain error if it's wrong, then films the lab: the drive, its timeline and a playhead, with the music's sound. It also writes a `.png` still.
3. Sends the `.mp4` (SendUserFile) and the recipe in a ```` ```json ```` block, with its size in bytes.
4. Changes it when Jonny says "slower" (longer `every`/`for`), "more orange" (colour slot 2, or a `tint` layer), and sends a new clip. A colour that has to be exact whatever the colour set (a green from a DJ's screen, a brand colour) goes in `custom` as colour 6 onwards, rather than borrowing a set slot; `--colours` doesn't change those.

Jonny copies the recipe (the whole message is fine: the lab finds the recipe in it) into **Routines → Animation lab**, checks it in his own colours and on his drive's profile, and saves it. The lab:

- reads it however it was copied: a ```` ```json ```` block with words around it, curly quotes, `//` comments, a comma before `}` or `]`, names without quotes;
- shows anything else as a plain error with where it is ("Line 9: a comma is missing before "rise"", "Step 2, layer 1 (pulse): "color" isn't a setting of "pulse" (did you mean "colour"?)"), with a **Show me where** button; the error can be pasted back into the session;
- warns about recipes that work but probably aren't meant (times of 20 ms or less in an ms recipe, beat timing on a Core);
- plays it on the drawing from the drive profile, in the colours from Tune it or a saved colour set; a beat-timed one with a steady beat (any BPM), the demo track or a song clip (picked on the computer, never uploaded or saved), heard through the Pulse's simulated mic in a chosen room, from "Start at", optionally with sound; a one-shot timed in ms can run into the built-in ambient or a saved loop ("Then");
- saves it to the library's `animations/` folder as `<board>-<name>.json` (the same name replaces it), one layer per line, steps kept as steps. Saved ones open again from "Start from", next to the built-in recipes.

`js/lab.js` reads and checks pasted text (`readRecipe`) and writes the files; `js/lab-tab.js` is the lab on screen; `test/lab.test.mjs` checks the forgiving reading, every error message and the saving.

## Today's looks as recipes (R2 results, 20 Oct 2026)

| Recipe | Bytes | Compared with today's preview |
|---|---|---|
| Engine (Core start-up) | 66 | Within 4 of 255 on every channel, every 10 ms for 25 s (with Drift) |
| Drift (Core ambient) | 18 | (as above) |
| Pulse start-up (7 steps) | 84 | Front LEDs: biggest difference 27 (the top pulses: 333 ms each today, 330 here, as times are in 10 ms steps), average 1. The back LEDs 4 and 6 are a shade off in the rainbow: one `twist` can't copy today's hand-picked offsets |
| Pulse ambient | 32 | Within 2, all 8 LEDs, on the demo track in a club |
| Heartbeat (plug-in) | 28 | Biggest 17, average 2: the preview's ±8 sparkle in the flow isn't in the recipe, and the preview's levels are linear while the player squares |

**Core's settings room:** Engine 66 + Drift 18 + 4 colours (12) + brightness + layout byte = **98 of 98 bytes**: it fits, with nothing spare. A Core routine with a longer start-up needs fewer cranks, or R6 must find more EEPROM.

The comparisons use evenly spaced sections, as today's engines do. The Routines tab draws the player with the drive profile's real heights (Pulse's middle LED is 73 % up, not 50 %), so the middle LED changes a little later in the rise and the pour there.
