# Power-line protocol and station wiring

The Flash Station talks to a sealed drive only through its USB 5 V. A transistor in the drive's ground return drops the supply by one diode drop (about 0.6 V) for each 0 bit. The drive's data lines are never touched, so the memory chip is unaffected. A drive answers back by flickering its LEDs, which the station reads on the sense wire: when it's plugged in (coretest 1.4, pulsetest 1.4; station 0.2's `WAIT`) or to a station hello (coretest 1.3 on; station 0.2's `ASK`).

## Station wiring (XIAO RP2040)

```
XIAO 5V ──────────────────────────────────── socket VBUS (red)
socket GND (black) ──┬── 1N4001, stripe towards XIAO GND ──┐
                     └── BC337 C ── E ──────────────────────┴── XIAO GND
XIAO D6 (TX, GPIO0) ── 470 Ω ── BC337 B
socket GND (black) ── 10 kΩ ─────────────────── XIAO A0 (sense wire, below ~1 V)
```
The 10 kΩ protects A0 if the diode is ever fitted backwards. Status LEDs (2 white on D4/D5, 2 RGB on D1–D3 and D10–D8) are in the firmware repo's `station/README.md`.
Line idle (high) = transistor on = full 5 V. A 0 bit = transistor off = dip. Same as the Pi's pin 8 in the old guides.

## Station commands (firmware station 0.3)
USB serial (CDC, any baud setting). One line in (end with `\n`), one line out.

| Send | Reply |
| --- | --- |
| `HELLO` | `SYNAPTO-STATION 0.5` (0.4 only spots a plug-in by the drive's current: on the first bench run it never did; 0.1 has no ASK or WAIT; 0.2 has no SOCKET, LEVELS, GONE or OK EMPTY; 0.3 doesn't count the 1.5 ID frame's copies, so its green light and station mode miss 1.5 drives) |
| `SEND <baud> <stopbits> <hex> <gapMs>` | `OK` after the last stop bit has gone and the line has then been held at full supply for gapMs (plus about one bit). Baud 70–20000, stop bits 1–2, 1–4096 bytes (hex, either case), gap 0–60000. Station 0.3: `OK EMPTY` instead if the socket was empty at any point during it (below) |
| `SENSE` | `SENSE <raw 0-4095> <millivolts>` on A0 (average of 64) |
| `SHOW` | `OK` (replays the station's start-up light show) |
| `ASK <baud> <stopbits> <hex> <listenMs>` (station 0.2) | `HEARD <hex>`, or `HEARD` alone if nothing was heard. Sends like SEND, then holds full supply for listenMs while reading the drive's answer on A0 (below). Station 0.3: `OK EMPTY` (and no listening) if the socket was empty |
| `WAIT <ms>` (station 0.2) | `DRIVE <hex>` as soon as a drive is plugged in (`DRIVE` alone if it said nothing), or `NONE` after ms (1–60000) with no plug-in. Station 0.3: also `GONE`, once, after the drive has been unplugged. Plug-ins and unplugs between two WAITs are reported in order, one per WAIT |
| `SOCKET` (station 0.3) | `SOCKET IN` or `SOCKET EMPTY`. If the box thinks the socket is empty it checks with one 5 ms dip first (a drive already in when the box powered up is found this way) |
| `LEVELS` (station 0.3) | `LEVELS <empty> <in> <dip> <low> <high>`: A0 at the last plug-in, raw counts (0.8 mV each): the empty level before, the reading 10 ms in (drive just powered up), the average in the signal's dips, and the lowest and highest 0.4 ms averages while the box listened for the ID. `LEVELS NONE` before the first plug-in. The app logs it after every plug-in ("Socket levels: …"): these are the bench numbers for `PLUG_MARGIN`, `LISTEN_MIN_SWING` and the dip thresholds |
| anything wrong | `ERR <what to fix>` |

**How the box listens (station 0.2, built 17 Oct 2026, simulated only; firmware repo `station/README.md`):** the ADC reads A0 10,000 times a second on its own (10 readings a bit). LEDs on draw more current, so A0 sits higher: that is a 1 (and the idle level), LEDs off is a 0. Readings are averaged in fours; the threshold sits halfway between the lowest and highest averages so far, with an eighth of that as hysteresis, and nothing is decoded until they are at least 16 counts (13 mV) apart. Each byte is 1000 baud 8N1, LSB first; each bit is the majority of 3 readings around its middle; a byte whose stop bit isn't 1 is dropped. The reply holds every byte decoded, in order, up to 512. The box doesn't check the copies: the app does (`parseHello` in `js/station.js`). The app only uses ASK and WAIT when `HELLO` says 0.2 or later; with 0.1 it falls back to a plain SEND hello and picks the drive by hand. `js/sim-station.js` `SimStation` answers like station 0.2 (or 0.3, which the app's simulated station uses).

**ASK:** sends like SEND, then listens straight after the last stop bit (one bit later) for listenMs and replies `HEARD <hex>`. For the Core hello (`ASK 100 2 5AA5010409 3500`) the drive has already started answering by then, so the first of its 43 copies is usually cut short: expect 42 (coretest 1.5: 34 copies of its longer frame, expect 33).

**WAIT:** the app keeps a `WAIT 1000` going whenever it isn't sending. The box watches A0 every millisecond, between commands as well as during WAIT:
| After plug-in | What the box does |
| --- | --- |
| 10 ms | A0 has stayed more than `PLUG_MARGIN` (8 counts) above the empty level for 10 ms: a drive is in. The empty level is learnt as a slow average while the socket is empty |
| 30 ms | The "you're on a station" signal: 15 × `F0` at 1000 baud, 1 stop bit (150 ms of the 100 Hz wake-up square wave). A drive on an ordinary USB port never hears it |
| 180 ms | Listens up to 400 ms like ASK, stopping as soon as 3 good copies of an ID are in |
| ~0.4 s | Kept until a WAIT reports it, once (`DRIVE <hex>`; `DRIVE` alone if nothing was heard). Box flashes green if it heard an ID, blinks red if not |

A drive counts as gone only after 0.5 s near the empty level, so a drive whose LEDs go dark for a moment isn't "plugged in" again (the signal restarts a running Pulse). A plug-in during a SEND or ASK, or within 1 s after one, isn't introduced: the app is already talking to that drive (a send that found the socket empty doesn't count). `PLUG_MARGIN` and the 16-count swing are guesses until the bench readings (`LEVELS`, logged by the app after each plug-in).

**Finding a drive that goes in (station 0.5, built 20 Oct 2026, simulated only).** While the socket is empty the box sends one 5 ms dip every 100 ms; a drive reads ~750 on A0 in a dip, an empty socket ~0, so a drive is found within ~0.1 s whatever it draws at full supply, and then gets the plug-in signal as before (the old current check still works too). Every engine ignores single 5 ms dips (they're the same as the in-step dips). Why: on the first bench run with station 0.4, sends found the drive (by their dips) but no plug-in was ever reported.

**Knowing the socket is empty (station 0.3, built 18 Oct 2026, simulated only).** Found on the bench 18 Oct 2026: a settings send to an empty socket went ahead and the app saved it in the register. In a dip (transistor off) the drive's current has to go through the diode, so with a drive in the socket's ground sits ~0.6 V up (~750 counts on A0), lit or dark; with nothing in, it stays at ~0. At full supply a dark drive can read close to an empty socket, so dips are what settle it:
- Between commands: 0.5 s near the empty level, then one 5 ms check dip. A drive still there (dark) is kept and the checks spread out (0.5, 1, 2, then every 4 s) until it reads clearly lit or clearly lower than "empty" again; nothing there: `GONE` for the next WAIT.
- During a SEND or ASK the box reads A0 every 0.1 ms, separately at full supply and in the dips (a reading counts once the line has held its level for 0.3 ms). A reading of 250 or more in a dip is a drive; 30 dip readings in a row under 125 is an empty socket, so a drive pulled out is noticed within a few bytes (every byte has a dip: its start bit). Unplugged during a long gap, it's noticed at the next SEND's first dips. Unplugged in the last gap of a plan, the plan's last `OK` still comes back; WAIT then says `GONE`.
- `OK EMPTY` if the socket was empty when the SEND started (as far as the box knew) or at any point during it. Every SEND before it was answered `OK`, so the drive had all of those.

**What the app does (app task 6):** before any send or Find it asks `SOCKET`; empty → nothing is sent ("The socket is empty. Plug P-0001 in, wait for its card, then send."). An `OK EMPTY` stops the plan; the register's lighting and engine stay as they were and the history says what the drive may have got (`unpluggedResult` in `js/station.js`): nothing ("Unplugged after 6 s, nothing changed"), a Pulse after its first page frame went out ("…it may be unfinished (it waits red for the rest)"), a Core after a whole settings or forget copy ("…it may have the new lighting"). `GONE` turns the card's tag to "Unplugged" and the main send button to "Plug the drive in" (a click asks the box again). With station 0.1/0.2 the app says once that the box can't tell and sends as before.

**The plug-in animation (station 0.3 box side; drive side not built yet).** Box and drive light up as one unit; the look and every number come from the firmware repo's `station/preview/plugin_animation.html` (Jonny's choice, 18 Oct 2026), copied into `station/patterns.h`; `station/show_core.h` does the maths and matches the page to within 1 level every millisecond (firmware `station/tests/run_tests.py`). Times are ms after the drive went in:
| When | Box (its LED line: 4 positions from the cable end to the socket; today white 1, white 2, RGB 1, RGB 2) | Drive (when its engine joins in) |
| --- | --- | --- |
| socket empty | Slow breathe, 4 s a cycle, levels 4–36; fades back in over 0.9 s after an unplug | – |
| 0–180 | Dark while it sends the signal | Dark, listening |
| 180–886 | White pulse spreading out from the socket (120 ms per position, fade up 70 ms + 2.3 positions), level 200 × 30/70 = 86 (what the eye sees of the ID flicker) | The same |
| 886–1226 | Holds, listening for the ID | **Holds white and flickers its 3 ID copies from 886 ms** (280 ms with the fingerprint: 10 ms of on, then 3 × 90 ms) |
| 1226–1896 | Fades out from the socket (310 ms each) | The same |
| 1896–2146 | Resting glow 60 | The same |
| then, every 38.6 s | 12 heartbeats from the socket out (3 s each, rise 90 ms to 97, fade 720 ms, 65 ms per position), then one flow up and back (1.3 s each way, level 120, glow 2.7 positions, sparkle 8) | The same, in step |
| after a send, or no ID | Steady glow 60, no dips | Its own lighting |

- **Station mode only after a good ID** (at least one copy). The box listens from the signal's end until 100 ms after the pulse's ID time (about 1 s), stopping early at 3 copies, so today's drives (ID 20 ms after the signal) and ones that join in (ID at 886 ms) are both heard.
- **In-step dips:** in station mode the box sends one 5 ms dip (a single `F0` at 1000 baud) at the start of every heartbeat and of the flow: 2146 ms after plug-in, then every 3 s (2.6 s across the flow). A drive in station mode locks its heartbeat to them and plays its own lighting once they stop (no dip for more than 4.5 s). Too short and too far apart to be a wake-up call: checked against pulsetest 1.4's bootloader and routine listener and coretest 1.4's receiver, which all take no notice. The dips also tell the box the drive is still in. A SEND or ASK ends station mode (the drive shows its new lighting until it's re-plugged).
- **The drive side: pulsetest 1.5 (built 20 Oct 2026, simulated only; firmware repo `pulsetest/README.md`).** Its bootloader hears the signal as before, and when the line has been full for 20 ms (~195 ms after plug-in) starts a 1.5 routine with a note (GPIOR3 = A5) after checking only the routine's trailer page. The routine plays the drive's half of the table above (its 3 sections at positions 4, 5, 6 of the line), flickers its ID with the fingerprint from 886 ms at level 200 (station 0.4 listens to 1.27 s), and from 2146 ms lines its clock up with each in-step dip that lands within 0.3 s of a heartbeat's or the flow's start. No dip for 4.5 s: it restarts and plays its own lighting. A wake-up call still hands over to the bootloader. Routines before 1.5 on a 1.5 bootloader: the bootloader introduces itself as 1.4 did (with the new frame) and the box plays its half alone.
- **Every drive, one line of light:** the drives' LED sections sit at their real heights on the line above the box's last LED: Pulse bottom (LEDs 1, 2, 7, 8) 0, middle (3, 4) 1, top (5, 6) 2; Core bottom (1, 2, 5, 6) 0, top (3, 4) 1.4 (46.5 mm up, between the Pulse's 41.5 and 54.5). The line runs to 2 for both, so the box's timing never depends on the drive. The preview has a Pulse/Core picker. Core doesn't play its half yet (no room on the ATtiny412: firmware roadmap task 9).

**The ID frame with the lighting fingerprint (pulsetest 1.5, coretest 1.5; firmware roadmap task 7):** `5A`, ID card bytes 5–8, the fingerprint (2 bytes, low first), CRC-8 (poly 0x07, start 0) of those 6. Pulse: the app CRC from the trailer page (`PulseImage`'s CRC-16 of the routine with its settings page, so a new colour set changes it); `FFFF` when an update was cut off (the trailer is blank). Core: CRC-16/CCITT (start 0xFFFF) of the 98 settings bytes in use: the EEPROM ones if valid (the same as the CRC stored with them), else the flashed block's from its layout byte on. Older drives keep sending the 6-byte frame; station 0.4's `idCopies` and the app's `parseHello` take both, the longer one first (if both fit, 1 in 256, and a `5A` follows the short one, it's the short one). The app logs the fingerprint ("lighting fingerprint 4112"); checking it against the register is roadmap task 7.

**What the drive does on plug-in (coretest 1.4, simulated only; pulsetest 1.4, bench-tested 18 Oct 2026 on a Pulse A2 and station 0.2):** for the first 300 ms after power-up, listen for at least 8 dips at 100 Hz. If heard, 20 ms after the line stays full, light the LEDs; 10 ms later flicker **3 copies** of the hello answer (same frame as below: `5A`, ID card bytes 5–8, CRC-8; LEDs on = 1, 10 ms of on after each copy, about 0.2 s), then carry on as normal. pulsetest's bootloader listens for this square wave at power-up as its wake-up call (1.1-1.3 checked the routine first, ~0.17 s, and missed it; 1.4 listens first), so it answers from the bootloader, then waits for frames and times out into the routine as usual. The app checks the 3 copies with `parseHello` and takes the one heard most; a drive with no ID card sends `FF FF FF FF`.

**Drives on today's engines with station 0.2:** they say nothing (`DRIVE` alone): the app says so and offers Find (ASK) or picking by hand. A Core on coretest 1.3 ignores the signal. A Pulse on pulsetest 1.0 takes it for the station calling: its bootloader lights red, waits about 1.5 s for frames and then starts the routine (simulated: 1.7 s after plug-in, flash untouched).

One SEND per frame, as the Pi tool did one `write` + `flush` + `sleep`: e.g. pulsetest's settings plan is `SEND 1000 1 F0F0…(500 bytes) 0`, then `SEND 1000 1 5AA548… 150`, and so on. A 5 s wake-up call is 500 bytes, so it fits in one SEND. Bits are timed by the RP2040's PIO, so USB and the lights can't move them; between SENDs the line rests high for the USB turn-around (0.2–3 ms, like the Pi's flush/sleep wobble).

## pulsetest (bootloader protocol), 1000 baud, 8N1, LSB first

**Wake-up call:** `0xF0` bytes back to back = a 100 Hz square wave (5 ms dipped, 5 ms full). The bootloader listens for it for 0.12 s at power-up; the running routine listens all the time and resets into the bootloader when it hears about 12 in a row. So a drive can be plugged in before or after a job starts.

**Frame:** `5A A5 type len payload[len] crc_lo crc_hi`, CRC-16/CCITT (poly 0x1021, init 0xFFFF) over type, len and payload.

| Type | len | Payload |
| --- | --- | --- |
| `'H'` header | 36 | image id (u16) · flags (bit 0 = settings patch) · app length (u16) · app CRC (u16) · code CRC (u16, the app without its settings page) · settings page index · page mask (26 bytes, bit per page) |
| `'P'` page | 68 | image id (u16) · flags · page index (0 = 0x0C00, 207 = trailer) · 64 data bytes |
| `'T'` test | 3 | r g b: show a colour for a moment, save nothing |

**Image id** = CRC-16 of app bytes + trailer. **Trailer page** (index 207, flash 0x3FC0): `"SPL1"`, app length, app CRC, code CRC, settings page, version major, minor, … , CRC-16 of bytes 0–61 at 62. `js/engines.js` `PulseImage` builds all of this exactly like the Pi tool.

**Plans** (from the Pi tool `pulse_station.py`; gaps are after the frame):
- *Link test:* wake 3 s, then the `T` frame repeated with 0.1 s gaps for ~20 s.
- *Settings:* wake 5 s, then 4 copies of [header (0.15 s gap), settings page, trailer (0.03 s gaps each)], with 0.4 s of wake before each copy after the first. Patch flag set. About 15 s.
- *Whole engine:* wake 5 s, then 2 passes of every page and the trailer (0.03 s gaps), with 0.4 s of wake + a header (0.15 s gap) before every 8th page. About 6 min (1 pass ≈ 3 min).

The bootloader writes only pages that differ, marks the routine unfinished before the first change and writes the trailer last, so an interrupted send never runs half a routine.

## Beat v1.2 (settings only, no bootloader), 100 baud

Start bit (dip), 8 data bits LSB first (dip = 0), 2 stop bits (full), 10 ms per bit. Message: `5A A5 len payload… crc8` with CRC-8 poly 0x07 over len + payload. The station sends three copies.

| Payload | Meaning |
| --- | --- |
| `01 r g b` | link test, nothing saved |
| `02` + 45 settings bytes (the `SOTA.MIC` block from its layout byte) + CRC-16 | new settings, saved to EEPROM |
| `03 5A` | forget sent settings, back to the flashed ones |

## coretest 1.3 (Core, settings only, no bootloader), 100 baud

Core has no divider: the chip reads its own 1.1 V reference against its supply 1,000 times a second, so a dip shows up with no extra parts. Needs the 10 MHz build of coretest 1.3 or later; older Core engines can't hear the station. Source: firmware repo `coretest/README.md`, "Flash Station protocol (Core)".

**Line:** start bit (dip), 8 data bits LSB first (dip = 0), 2 stop bits (full), 10 ms a bit. Station command: `SEND 100 2 <hex> <gapMs>`. Same as Beat v1.2. No wake-up call.

**Message:** `5A A5 len payload… crc8`, CRC-8 polynomial 0x07, start 0, over len and payload. Each message is sent 3 times, one SEND a copy, with a 300 ms gap.

| Payload | Meaning |
| --- | --- |
| `01 r g b` | Link test: all 6 LEDs show this colour (as sent, no brightness cap) for 2 s. Nothing saved. Blue is exactly `5AA504010000FF6A` |
| `02` + 98 bytes + CRC-16 | New settings: the `SOTA.LED` block from its layout byte on (bytes 8–105), then CRC-16/CCITT (poly 0x1021, start 0xFFFF) of those 98 bytes, low byte first. len = 101. Refused unless the layout byte is 1 and both checks pass. Saved in EEPROM; the animation restarts from power-on. A copy that matches what's saved is ignored |
| `03 5A` | Forget the sent settings, back to the ones in the flash (animation restarts) |
| `04` | Station hello (below). Sent **once**, gap/listen 3500 ms, so the line stays full while the drive answers |

**Plans** (`js/station.js`):
- *Link test:* 3 copies of the `01` message, 300 ms gaps. About 4 s (the drive shows each copy it hears for 2 s).
- *Settings:* 3 copies of the 105-byte `02` message, 300 ms gaps. 11.6 s a copy, about 36 s in all. A drive plugged in during copy 1 takes copy 2.
- *Back to flashed settings:* 3 copies of `03 5A`. About 4 s.
- *Station hello:* one `04` message, 3.5 s gap. About 5 s.

**Station hello (drive → station):** for 3 s all LEDs flicker full white / off. 1000 baud, 8N1, LSB first, LEDs on = 1 (and on between frames), off = 0. Frame: `5A`, ID card bytes 5–8 (family `C`, drive number low, high, board code), CRC-8 of those 4 bytes; then 10 ms of on. Sent 43 times (coretest 1.5: the frame with its fingerprint, above, 34 times, ~3.1 s). A drive with no ID card sends `FF FF FF FF`. The station sees it as a change in the current through its transistor (sense wire on A0). The app sends the hello with `ASK 100 2 5AA50104<crc> 3500` (station 0.2 on), takes the answer heard most often, and picks that drive in the list ("Find the drive in the socket"). Station 0.1 can't read it (it only averages A0).

**Pulse (pulsetest 1.4):** introduces itself on plug-in (above), which is all the app needs. A Pulse answer to a station hello sent later is optional; if it's added, choose its message in the firmware repo, add its plan next to `coreHelloPlan` and ask with both.

**EEPROM:** bytes 0–97 settings (from the layout byte), 98–99 their CRC-16. Re-initialising a drive at the Initialisation Station erases EEPROM, so it goes back to the settings in the file it was given.
