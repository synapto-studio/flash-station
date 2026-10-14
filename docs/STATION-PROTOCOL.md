# Power-line protocol and station wiring

The Flash Station talks to a sealed drive only through its USB 5 V. A transistor in the drive's ground return drops the supply by one diode drop (about 0.6 V) for each 0 bit. The drive's data lines are never touched, so the memory chip is unaffected. Drives can't answer back yet (see the station hello in the roadmap).

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
| anything wrong | `ERR <what to fix>` |

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

## coretest
No receiver yet. coretest 1.3 adds one (10 MHz build, settings into EEPROM, like Beat) plus the station hello. Its protocol gets added here when it's written.
