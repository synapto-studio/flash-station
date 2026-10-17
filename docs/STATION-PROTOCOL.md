# Power-line protocol and station wiring

The Flash Station talks to a sealed drive only through its USB 5 V. A transistor in the drive's ground return drops the supply by one diode drop (about 0.6 V) for each 0 bit. The drive's data lines are never touched, so the memory chip is unaffected. A drive answers back only to a station hello (below), by flickering its LEDs; station 0.2's `ASK` reads that on the sense wire.

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

## Station commands (firmware station 0.1)
USB serial (CDC, any baud setting). One line in (end with `\n`), one line out.

| Send | Reply |
| --- | --- |
| `HELLO` | `SYNAPTO-STATION 0.1` |
| `SEND <baud> <stopbits> <hex> <gapMs>` | `OK` after the last stop bit has gone and the line has then been held at full supply for gapMs (plus about one bit). Baud 70–20000, stop bits 1–2, 1–4096 bytes (hex, either case), gap 0–60000 |
| `SENSE` | `SENSE <raw 0-4095> <millivolts>` on A0 (average of 64) |
| `SHOW` | `OK` (replays the station's start-up light show) |
| `ASK <baud> <stopbits> <hex> <listenMs>` (station 0.2) | `HEARD <hex>`, or `HEARD` alone if nothing was heard. Sends like SEND, then holds full supply for listenMs while reading the drive's answer on A0 (below) |
| anything wrong | `ERR <what to fix>` |

**ASK, for station 0.2 (to build in the firmware repo):** after the last stop bit, sample A0 at least 8 times a bit (8 kHz or faster) for listenMs. LEDs on draw more current, so A0 sits higher: that is a 1 (and the idle level), LEDs off is a 0. Set the threshold halfway between the lowest and highest readings so far. Decode 1000 baud, 8N1, LSB first (start bit = low, stop bit = high) and reply with every byte decoded, in order, up to 512 bytes. No checking or framing in the box: the app finds the copies and checks their CRC-8 (`parseHello` in `js/station.js`). The app only uses ASK when `HELLO` says 0.2 or later; with 0.1 it falls back to a plain SEND hello and picks the drive by hand. `js/sim-station.js` `SimStation` answers ASK like this.

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

**Station hello (drive → station):** for 3 s all LEDs flicker full white / off. 1000 baud, 8N1, LSB first, LEDs on = 1 (and on between frames), off = 0. Frame: `5A`, ID card bytes 5–8 (family `C`, drive number low, high, board code), CRC-8 of those 4 bytes; then 10 ms of on. Sent 43 times. A drive with no ID card sends `FF FF FF FF`. The station sees it as a change in the current through its transistor (sense wire on A0). The app sends the hello with `ASK 100 2 5AA50104<crc> 3500` (station 0.2 on), takes the answer heard most often, and picks that drive in the list ("Find the drive in the socket"). Station 0.1 can't read it (it only averages A0).

**Pulse (pulsetest 1.1, not written yet):** should answer with exactly the same flicker, so the box and the app need nothing new. Only the hello message pulsetest hears is still to be chosen in the firmware repo; once it is, add its plan next to `coreHelloPlan` and ask with both.

**EEPROM:** bytes 0–97 settings (from the layout byte), 98–99 their CRC-16. Re-initialising a drive at the Initialisation Station erases EEPROM, so it goes back to the settings in the file it was given.
