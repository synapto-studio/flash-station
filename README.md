# Flash Station

Synapto's browser app for the Initialisation Station and the Flash Station.

- Runs in Chrome or Edge (it needs Web Serial to talk to USB devices).
- No install, no server: open the page, plug in the programmer or the station.
- Firmware, routines and the drive register live in a library folder on your computer, never on this site.

## Folders

- `index.html`, `app.css`, `js/` – the app.
- `test/` – tests run in Node against a simulated ATtiny (`npm test`).

The UPDI flashing code is a JavaScript port of Microchip's pymcuprog SerialUPDI stack (MIT licence).
