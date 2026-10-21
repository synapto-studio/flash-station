# Flash Station app

Synapto's browser app for its LED USB drives. Two stations:
- **Initialisation Station (IS):** Jonny's bench tool. Adafruit UPDI Friend (CH340) + one pogo pin puts the engine, bootloader, BOOTEND fuse and ID card on bare boards.
- **Flash Station (FS):** the product. A Seeed XIAO RP2040 box dips a sealed drive's USB 5 V to send it settings or a whole engine.

Live at https://synapto-studio.github.io/flash-station/ (GitHub Pages from `main`, root). Chrome/Edge only (Web Serial, File System Access).

## Who you're working with
Jonny: product designer/engineer, new to software. Explain in plain words, short steps and tables, no jargon without a one-line meaning. Always say which station and which board (Core / Pulse) an answer is for.

Jonny wants regular reminders on using Claude efficiently. When a session gets long, drifts to a new topic, or a task is finished, say so in one line and suggest starting a fresh session, with the exact first message to paste (usually "Read docs/ROADMAP.md and do task N"). Tick finished tasks off in `docs/ROADMAP.md` before ending.

## Commands
- `npm test` – all JS tests (Node 22, `node --test`). Run after every change.
- `python3 test/pymcuprog_bytes.py` – browser flasher must send byte-for-byte what pymcuprog sends (needs `pip install pymcuprog`). Run after touching `js/updi.js` or `js/sim.js`.
- `python3 test/pymcuprog_vs_sim.py` – real pymcuprog against the simulated chip.
- Local preview: `python3 -m http.server 8765` then open http://localhost:8765 (Web Serial works on localhost).
- `node tools/animation-clip.mjs recipe.json --out clip.mp4 [--music demo --start 8] [--colours "red=r,g,b orange=… white=…"]` – preview clip of an animation recipe (headless Chromium + ffmpeg).

## Animations
When Jonny describes an animation, follow "Making an animation in a session" in `docs/ANIMATION-FORMAT.md`: write the recipe, make a clip with `tools/animation-clip.mjs`, send him the `.mp4` and the recipe in a ```json block to paste into Routines → Animation lab.

## Rules
- IMPORTANT: this repo is public. Never commit firmware (.hex, .ino, .c), routines, the drive register or anything from the library folder. Those live in Jonny's library folder or the private firmware repo.
- Plain ES modules, no build step, no frameworks, no npm runtime dependencies. Everything must work by opening `index.html` from GitHub Pages.
- Never write fuse 5 (SYSCFG0): it can lock the chip out for good. `updi.js` only allows APPEND (7) and BOOTEND (8).
- Demo engines (`js/demo.js`) must never reach a real programmer.
- Anything that talks to hardware gets a simulated version and a test first (see `js/sim.js`). Check UI changes with a headless Chromium screenshot (Playwright; Chromium is at /opt/pw-browsers in cloud sessions).
- UI copy: sentence case, plain verbs, errors say what to do next. Smoked-resin dark theme; orange (`--resin`) is the only accent.
- Engine names: **coretest** (Core, ATtiny412, was "Motor Start"), **pulsetest** (Pulse, ATtiny1614, was "Rise"), **Beat** (older Pulse engine). Drive labels: C-0001, P-0001.

## Map
- `js/updi.js` UPDI programmer (port of pymcuprog SerialUPDI) · `js/serial.js` Web Serial transport · `js/sim.js` simulated chip
- `js/engines.js` engine detection, settings layouts, pulsetest image (matches `test/ref_pulse_station.py`)
- `js/idcard.js` 32-byte ID card in the user row · `js/library.js` library folder + drive register · `js/profiles.js` drive profiles (LED count, groups, positions) · `js/routines.js`, `js/phases.js`, `js/palettes.js` routines, phase files, colour sets · `js/initialise.js` IS flow
- `js/songs.js` song moments (R1): frame answers, prints, training, the drive's matcher (C twin in firmware `pulsetest/songmatch/`) · `test/song_experiment.mjs` R1 on real clips (needs ffmpeg; clips never committed)
- `js/moments.js` song moments (R4): beat grid, Listen for / Play at, learning in 8 simulated rooms, moment files, what the drive plays · `js/moments-tab.js` the Song moments screen in the Routines tab · `js/moments-worker.js` learning off the screen
- `js/player.js` animation player and recipe bytes (R2; spec `docs/ANIMATION-FORMAT.md`) · `js/animations.js` today's looks as recipes
- `js/lab.js` Animation lab (R3): reads pasted recipes with plain errors, `animations/` files · `js/lab-tab.js` the lab in the Routines tab · `tools/animation-clip.mjs` preview clips
- `js/main.js` UI · `js/drive-art.js` the drive drawing
- `docs/ROADMAP.md` what to build next, in order, with how to check each part
- `docs/STATION-PROTOCOL.md` the power-line protocol and the XIAO wiring
- `docs/SONG-RECOGNITION.md` R1 results: can a Pulse recognise a moment in a song (go)
