# Roadmap

One task per Claude Code session. Start each session with: "Read docs/ROADMAP.md and do task N." Tick it off here when it's done and checked.

## Done
- [x] **Fix: Flash Station said "No Pulse drives in the register"** (15 Oct 2026). The Initialise tab saved a drive's family as the letter `P`, the Flash Station tab looked for `pulse`. New drives are saved as `pulse`/`core`, and `Library.drives()` reads old `P`/`C` records as `pulse`/`core`, so drives already in the register show up with no re-initialising. Checked by `test/initialise.test.mjs` and in headless Chromium (initialise a simulated Pulse, Flash Station tab lists P-0001).
- [x] **Task 4: routine editor, finished** (15 Oct 2026, last part). Drive profiles: `js/profiles.js` (a profile is a casing code and board, its LED count, groups, and each LED's x/y in mm from the plug up to the logo), saved as `casings/<casing>-<board>.json` via `Library.profiles()` / `saveProfile()` / `profileFor(casing, board)`. The Routines tab draws the drive from the chosen profile (built-in "Estimated positions" until you save one) and has a Drive profile section: edit each LED's position, type the casing code, save. `engineToPreview()` in `js/routines.js` turns a resolved routine (or what's on a chip) into preview settings. Checked by `test/profiles.test.mjs`: for Core and Pulse, a routine built from saved phase files, colour set and brightness initialises a simulated board; the settings read back from the chip are the routine's and the preview of them matches the preview of the routine. Also run through the real UI in headless Chromium (save profile, build routine, Initialise the simulated Pulse: "P-0001 initialised"). Not yet: delete or rename a profile, the Initialise tab doesn't draw the drive from the casing's profile, the 3D preview; positions of LEDs on the back and the LED spacing are still unmeasured.
- [x] **Routine builder** (15 Oct 2026, fourth part of task 4). `js/routines.js`: a routine picks one phase file per phase (the newest version of a name, or one version pinned as `name@2`), a colour set (its colours are copied in) and an optional brightness. `Library.saveRoutine()` saves `routines/<board>-<name>.json`; the same name replaces. Routines tab has a Routines section: pick the files, save, then pick a saved routine and Show in preview (it resolves through `resolveRoutine` and fills the settings above). Checked by `test/routines.test.mjs` (resolves and packs for the engine) and in headless Chromium with the demo library. Not yet: delete or rename a routine, Initialise/Flash Station dropdowns only refresh the next time the library is read, and a built routine hasn't been run through a simulated board in the UI.
- [x] **Phase files** (15 Oct 2026, third part of task 4). `js/phases.js`: a phase file (load-up, standard, beat; recognition has no settings yet) holds that phase's settings under the engine's own names, taken from the phase tags in `js/engines.js`; colours stay out (colour sets cover them). `Library.phaseFiles()` / `savePhaseFile()` save into `phases/` and every save of a name makes the next version (`pulse-loadup-fast-rise-v2.json`), never overwriting. `resolveRoutine` now also ignores phase files for the other board. Routines tab has a Phase files section: pick a phase, save the current settings under a name, or pick a saved file and use it. Checked by `test/phases.test.mjs` (including resolving and packing the result) and in headless Chromium with the demo library. Not yet: a screen to build and save routines, and the preview doesn't read routines yet.
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
**First real run (16 Oct 2026), Pulse A2 P-0002:** app → box → socket all work (sends finish, socket VBUS averages ~4.7 V during the wake-up call). The drive only hears the station if it is plugged in *during* the wake-up call (bootloader's power-up listen works). A drive already running pulsetest 1.0 does not reset into the bootloader on the wake-up call, so that listener is missing or not working in the engine firmware: fix in the private firmware repo. Until then: click the send, then plug the drive in within ~2 s.
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

### 4. Routine editor — DONE 15 Oct 2026
- Phase files per phase (load-up, standard, beat, recognition) and versions: DONE (see Done above). Routine screen: DONE (see Done above).
- Saved colour sets (palettes) as library items: DONE (see Done above).
- Drive profiles: LED count, groups, each LED's position from plug to logo (`casings/*.json`): DONE (see Done above).
- Live previews: DONE (see Done above). Preview shows a saved routine and uses the drive profile's LED positions.
Done when: a routine built in the editor initialises a simulated board and the preview matches the settings sent. DONE 15 Oct 2026.

### 5. Station hello (needs firmware: pulsetest 1.1, coretest 1.3)
Drive plays its station animation only on the Flash Station; the pulse back into the station flickers ~1 kHz carrying family, drive number and board (ID card bytes 5–8). Station reads it on A0. App opens that drive automatically.

## Later
- Pulse engine 2: effects instead of fixed animations. Looping layers (shape, speed in bars, two colours, which LEDs, spread plug→logo) for standard and beat; a short step list for load-up.
- 3D drive preview from Fusion exports (.glb) using the drive profiles. Plan (15 Oct 2026): once the enclosure is on, Jonny exports the enclosure and the PCB (PCB is 1 mm thick). Each simulated LED gets mapped to its real position on the board, and the whole drive lights up, not just one side. Until then the Routines tab draws one side with estimated positions (`LED_SPOTS` in `js/routines-tab.js`: heights from Jonny's measurements, board and plug widths and LED spacing are guesses).
- rekordbox import: read beat grids and sections from a DJ's export on the drive, build per-track routines.
- Owner version of the app, modelled on SoundSwitch: good defaults first, custom editing for people who want it.
