# Flash Station app

Synapto's browser app for its LED USB drives. Two stations:
- **Initialisation Station (IS):** Jonny's bench tool. Adafruit UPDI Friend (CH340) + one pogo pin puts the engine, bootloader, BOOTEND fuse and ID card on bare boards.
- **Flash Station (FS):** the product. A Seeed XIAO RP2040 box dips a sealed drive's USB 5 V to send it settings or a whole engine.

Live at https://synapto-studio.github.io/flash-station/ (GitHub Pages from `main`, root). Chrome/Edge only (Web Serial, File System Access).

## Who you're working with
Jonny: product designer/engineer, new to software. Explain in plain words, short steps and tables, no jargon without a one-line meaning. Always say which station and which board (Core / Pulse) an answer is for.

Jonny does not know git or how code is organised, and only presses the buttons Claude tells him to. Never assume he knows words like branch, pull request, merge, conflict or commit: when one comes up, say in one line what it is and exactly which button to press (or offer to do it). Do the git work yourself where you can.

Each Claude session works on its own branch, and a pull request is the button that asks to merge that branch into `main` (which is what goes live). Jonny often has several sessions open at once. Two sessions given the same task build it twice and the pull requests then clash. So: at the start of a session run `git fetch` and look at `origin/main` and the other `origin/claude/*` branches to see whether the task is already done or in progress; tell Jonny before building something that already exists; and say which tasks are safe to run in parallel (different files) and which are not. Before ending, check the branch merges cleanly into `origin/main` (`git merge --no-commit --no-ff origin/main`, then abort) and tell Jonny in plain words if it doesn't.

Jonny wants regular reminders on using Claude efficiently. When a session gets long, drifts to a new topic, or a task is finished, say so in one line and suggest starting a fresh session, with the exact first message to paste (usually "Read docs/ROADMAP.md and do task N"). Tick finished tasks off in `docs/ROADMAP.md` before ending.

## Commands
- `npm test` – all JS tests (Node 22, `node --test`). Run after every change.
- `python3 test/pymcuprog_bytes.py` – browser flasher must send byte-for-byte what pymcuprog sends (needs `pip install pymcuprog`). Run after touching `js/updi.js` or `js/sim.js`.
- `python3 test/pymcuprog_vs_sim.py` – real pymcuprog against the simulated chip.
- Local preview: `python3 -m http.server 8765` then open http://localhost:8765 (Web Serial works on localhost).

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
- `js/idcard.js` 32-byte ID card in the user row · `js/library.js` library folder + drive register · `js/initialise.js` IS flow
- `js/main.js` UI · `js/drive-art.js` the drive drawing
- `docs/ROADMAP.md` what to build next, in order, with how to check each part
- `docs/STATION-PROTOCOL.md` the power-line protocol and the XIAO wiring
