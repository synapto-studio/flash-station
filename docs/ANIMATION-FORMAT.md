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
| `board` | `core` (6 LEDs), `pulse` (8) or `any` |
| `timing` | `ms` (times in milliseconds, steps of 10) or `beats` (times in beats, steps of 1/16; a bar is 4 beats) |
| `once` | `true`: a one-shot (start-up, song moment) that ends when its last timed layer ends, then the next section plays. `false`: loops (a loop with timed layers repeats every time the last one ends) |
| `layers` | Drawn in order: later layers go over earlier ones |
| `steps` | For one-shots, instead of (or after) `layers`: `[{ "for": 1200, "layers": [...] }, ...]`. A step's layers start when the step does and last as long as it, unless they give their own `at` (from the step's start) or `for` (may run past the step) |

**Every layer:** `move`, `leds` (`"all"` or LED numbers), `at` (when it starts, from the start of the animation; default 0), `for` (how long; left out = to the end). Each layer keeps its own time from its `at`, so a loop inside it starts at its beginning (`phase` shifts it).

**Colours** are slots in the routine's colour set, never "red": **1** red, **2** orange, **3** white, **4** yellow (Core's fourth colour; Pulse uses its orange), **5** the station box's warm white (255, 247, 234, fixed), **0** off. Any animation works with any colour set.

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

- **Header, 1 byte:** bits 0–3 number of layers (1–15), bit 4 timing in beats, bit 5 one-shot.
- **Each layer:** 1 byte: bits 0–3 the move's number (table order above: glow 0 … flicker 12), bits 4–5 when it starts (0 at the start, 1 when the layer before ends, 2 with the layer before, 3 at a time given next), bit 6 it has a length, bit 7 same LEDs as the layer before. Then the LED byte (bit 0 = LED 1) unless bit 7, the start time if 3, the length if bit 6, then the move's settings in the order of the table.
- **A time** is 1 byte `0xxxxxxx` (0–127 units) or 2 bytes `1xxxxxxx xxxxxxxx` (up to 32,767 units). Units: 10 ms, or 1/16 beat. `lag` is 1 signed byte of the same units.
- **Other settings:** colour, level, % width, loud, chance, twist: 1 byte. `fade`'s colours: 1 byte (from in the high 4 bits). `drift`'s colours: 2 bytes, 4 slots of 4 bits, 0 = unused. Levels `[from, to]`: 2 bytes. Positions: 1 signed byte = % / 2. Hits: a count, then on, off (5 ms units), peak.
- **Style byte** (last, for the moves that have one), from bit 0: `fade` blend (2 bits), curve (3); `pulse` up (3), down (3), blend (2); `wave` curve (3), round, land, back (1 each), blend (2); `fill` curve (3), side (1: 0 above, 1 below), blend (2); `wipe` curve (3). Curves: 0 linear, 1 ease, 2 in, 3 out, 4 exp. Blends: 0 over, 1 mask, 2 tint, 3 lift.

## Rules for a firmware player (R5, R6)

- Time inside the player: whole ms, or for beat-timed animations 1/65,536 of a bar (a recipe's 1/16 beat × 1024). The beat clock comes from the drive's tempo grid: the bar's phase (shown `leadMs` early) for locked pulses, and a smooth count of bars since the section started for everything else.
- `ease(x) = x·x·(765 − 2x) / 65025`; progress through a length is `t × 255 / len`; `mix(a, b, k) = (a(255 − k) + b·k) / 255`; going down, `a − (a − b)·k / 255` (never divide a negative number). The `exp` curve is the 24-entry table in `js/player.js` (exp(−x) in quarters, as the plug-in animation in pulsetest 1.5+).
- Heights are 0–10,000 from the plug; recipe positions × 100.
- Check against `js/player.js` frame for frame, like `run_equiv.js` does for today's routine.

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
