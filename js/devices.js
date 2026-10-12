// The chips the stations work with. Addresses and sizes from Microchip's ATtiny device
// pack, as used by pymcuprog. All three are tinyAVR 0/1-series: UPDI NVM version P:0,
// 16-bit addressing, flash mapped into data space at 0x8000.

export const DEVICES = {
  attiny412: {
    name: 'ATtiny412',
    id: 0x1e9223,
    family: 'core',
    flashSize: 0x1000,
    flashPage: 0x40,
    eepromSize: 0x80,
    eepromPage: 0x20,
  },
  attiny1614: {
    name: 'ATtiny1614',
    id: 0x1e9422,
    family: 'pulse',
    flashSize: 0x4000,
    flashPage: 0x40,
    eepromSize: 0x100,
    eepromPage: 0x20,
  },
  attiny3216: {
    name: 'ATtiny3216',
    id: 0x1e9521,
    family: 'pulseB',
    flashSize: 0x8000,
    flashPage: 0x80,
    eepromSize: 0x100,
    eepromPage: 0x40,
  },
};

// Shared memory map (data space) for these parts.
export const MAP = {
  flash: 0x8000,
  nvmctrl: 0x1000,
  sigrow: 0x1100,
  serial: 0x1103, // 10-byte factory serial number
  fuses: 0x1280,
  lockbits: 0x128a,
  userRow: 0x1300,
  userRowSize: 0x20,
  eeprom: 0x1400,
  syscfg: 0x0f00, // REVID at +1
};

// Fuse offsets (FUSE.xxx). Only BOOTEND and APPEND are ever written by this app.
// SYSCFG0 holds the UPDI/reset pin setting: writing it wrongly locks the chip out for good.
export const FUSE = {
  WDTCFG: 0,
  BODCFG: 1,
  OSCCFG: 2,
  TCD0CFG: 4,
  SYSCFG0: 5,
  SYSCFG1: 6,
  APPEND: 7,
  BOOTEND: 8,
};
export const WRITABLE_FUSES = [FUSE.APPEND, FUSE.BOOTEND];

export function deviceById(id) {
  return Object.values(DEVICES).find((d) => d.id === id) || null;
}

export function hexId(id) {
  return id.toString(16).toUpperCase().padStart(6, '0');
}
