# Flash Station

Synapto's browser app for the Initialisation Station and the Flash Station.

- Runs in Chrome or Edge (it needs Web Serial to talk to USB devices).
- No install, no server: open the page, plug in the programmer or the station.
- Firmware, routines and the drive register live in a library folder on your computer, never on this site.

## Folders

- `index.html`, `app.css`, `js/` – the app.
- `test/` – tests run in Node against a simulated ATtiny (`npm test`).

The UPDI flashing code is a JavaScript port of Microchip's pymcuprog SerialUPDI stack (MIT licence; see NOTICE-pymcuprog.txt).

## Tests

- `npm test` runs the JS tests: the flasher against a simulated ATtiny412/1614/3216, engine images, the ID card and the Initialise flow.
- `python3 test/pymcuprog_vs_sim.py` drives the simulated chip with the real pymcuprog (`pip install pymcuprog`): if pymcuprog can program it, the simulator behaves like a real chip.
- `python3 test/pymcuprog_bytes.py` checks the browser flasher sends byte-for-byte the same sequences as pymcuprog.
- The pulsetest image test compares against `test/ref_pulse_station.py`, the image code from the Pi tool.
