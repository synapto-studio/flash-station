# Roadmap

One task per Claude Code session. Start each session with: "Read docs/ROADMAP.md and do task N." Tick it off here when it's done and checked.

## Done
- [x] **Saved colour sets** (15 Oct 2026, second part of task 4). `js/palettes.js` (a set is a name, a board and its colours: Core WHITE/RED/YELLOW/ORANGE, Pulse white/red/orange), saved as `palettes/<board>-<name>.json` in the library via `Library.palettes()` / `savePalette()`. Routines tab has a Colour sets section: save the current colours under a name, pick one and use it. Same name replaces. Checked by `test/palettes.test.mjs` and in headless Chromium with the demo library. Not yet: delete or rename a set, and routines don't pick a set yet.
- [x] **Preview maths ported into a Routines tab** (15 Oct 2026, first part of task 4). `js/preview-core.js` and `js/preview-pulse.js` are line-for-line ports of the two pages in `reference/`; `test/preview.test.mjs` runs the reference pages and checks every LED byte matches (Core every 10 ms for 25 s, Pulse on the demo track, with changed settings too). `js/routines-tab.js` is the tab: Core or Pulse, 6/8 LEDs, scrubbable colour timeline, settings fields, Pulse plays a demo drum and bass track through a simulated mic. Settings are not saved or sent to a drive yet. Not yet compared against a real drive.
- [x] **Flash Station tab** (14 Oct 2026). `js/station.js` (frames, link-test / settings / whole-engine plans, station client), `js/sim-station.js` (simulated box and drive), `js/flash-tab.js` (the tab). Frames match `test/ref_pulse_station.py` byte for byte; a simulated drive ends with the new settings and a valid trailer. Every send is logged in the drive's history. Not yet run against the real box. Two details were not in the docs and were chosen (check against the Pi tool): the header's page mask lists the pages that follow (settings page + trailer for a settings send, every page for a whole engine), and a whole-engine send puts a header before the first page and every 8th page of each pass.
- [x] **Initialise tab** (12 Oct 2026). Browser UPDI flasher, simulated chip, engine detection, ID card, library folder, drive register, Terminal fallback. Not yet run on a real board.

## Next, in order

### 1. Real-board bring-up (when the UPDI Friend arrives)
Jonny runs this; Claude helps read results.
- Pulse A1, switch on 3V, board on USB power, pogo pin on UPDI pad. Choose UPDI Friend → Check board. Expect: ATtiny1614, ID 1E9422, "pulsetest 1.0" or "Unknown firmware".
- Initialise with `pulse_1.0_full.hex`. Expect: verified, start-up animation plays.
- Repeat on a Core A at 5V with `sota_leds_v1.2_10mhz.hex`.
- If anything fails: copy the Log, try 57600 baud, try the Terminal fallback. Fix in `js/updi.js` only with a matching change in `js/sim.js` and the pymcuprog tests passing.

### 2. XIAO station firmware (private firmware repo, not this one) — firmware done 14 Oct 2026, bench test to do
station 0.1 is in the firmware repo's `station/` (commands in `docs/STATION-PROTOCOL.md`). Checked in simulation and on an emulated RP2040. Left: build the box, flash the `.uf2`, press BOOT with a Pulse A2 in the socket and see the link-test colour.
Arduino (Earle Philhower's RP2040 core), output a `.uf2`. USB serial command set, one line in, one line out:
- `HELLO` → `SYNAPTO-STATION 0.1`
- `SEND <baud> <stopbits> <hex> <gapMs>` → sends the bytes on D6 (idle high = full 5 V, 0 = dip), holds full supply for gapMs, replies `OK`. Bit-banged with a hardware timer so 100 baud (Beat) and 1000 baud (pulsetest) both work.
- `SENSE` → average ADC reading on A0 (the sense wire), for drive detection later.
- RGB LED: idle dim, sending orange, done green.
Done when: a test harness proves bit timing within 2% at 100 and 1000 baud; Jonny's Pulse A2 shows a link-test colour.

### 3. Flash Station tab (this repo) — DONE 14 Oct 2026, see Done above
- Connect the station (Web Serial), check `HELLO`.
- Pick the drive from the register (offer the last one used).
- pulsetest: link test, send settings (patch plan), send whole engine (full plan). Port `test_plan`, `patch_plan`, `full_plan`, `header_frame`, `page_frame` from the Pi tool (`docs/STATION-PROTOCOL.md` has the formats).
- Log every send in the drive's history.
- A simulated station + simulated drive (bootloader frame decoder) for tests.
Done when: generated frames match `test/ref_pulse_station.py` byte for byte, and a simulated drive ends with the new settings page and a valid trailer.

### 4. Routine editor
- Phase files per phase (load-up, standard, beat, recognition), versions, routines that pick one file per phase.
- Saved colour sets (palettes) as library items: DONE (see Done above).
- Drive profiles: LED count, groups, each LED's position from plug to logo (`casings/*.json`).
- Live previews: DONE (see Done above). Left: drive the preview from the saved phase files and routines, and use the drive profile's LED positions.
Done when: a routine built in the editor initialises a simulated board and the preview matches the settings sent.

### 5. Station hello (needs firmware: pulsetest 1.1, coretest 1.3)
Drive plays its station animation only on the Flash Station; the pulse back into the station flickers ~1 kHz carrying family, drive number and board (ID card bytes 5–8). Station reads it on A0. App opens that drive automatically.

## Later
- Pulse engine 2: effects instead of fixed animations. Looping layers (shape, speed in bars, two colours, which LEDs, spread plug→logo) for standard and beat; a short step list for load-up.
- 3D drive preview from Fusion exports (.glb) using the drive profiles.
- rekordbox import: read beat grids and sections from a DJ's export on the drive, build per-track routines.
- Owner version of the app, modelled on SoundSwitch: good defaults first, custom editing for people who want it.
