// Drive profiles: how one casing is laid out. How many LEDs the board has, which LEDs work together
// (groups), and where each LED sits from the USB plug up to the logo. Saved in the library's
// casings/ folder, one file per casing and board (casings/sota-pulse.json). The Routines preview
// draws the drive from the profile.
//
//   { type: 'profile', name: 'SOTA', family: 'pulse', count: 8,
//     groups: { bottom: [1, 2], middle: [3], top: [5] },
//     leds: [{ led: 1, x: -3.5, y: 6.5 }, ...] }
//
// x is mm from the centre line (left is negative), y is mm above the top of the USB A connector,
// so a bigger y is closer to the logo. LEDs on the far side of the board are left out until their
// positions are known; the preview draws the LEDs that have a position.

import { slug } from './phases.js';

export const FAMILY_LEDS = { core: 6, pulse: 8 };

// Jonny's measured heights; board and plug widths and LED spacing are estimates (see ROADMAP).
const ESTIMATES = {
  core: {
    groups: { outer: [1, 2, 5, 6], inner: [3, 4] },
    leds: [{ led: 1, x: -3.5, y: 6.5 }, { led: 2, x: 3.5, y: 6.5 }, { led: 3, x: 0, y: 46.5 }],
  },
  pulse: {
    groups: { bottom: [1, 2], middle: [3], top: [5] },
    leds: [{ led: 1, x: -3.5, y: 6.5 }, { led: 2, x: 3.5, y: 6.5 }, { led: 3, x: 0, y: 41.5 }, { led: 5, x: 0, y: 54.5 }],
  },
};

// The profile used until a casing has its own: the estimates the preview always drew.
export function defaultProfile(family) {
  const e = ESTIMATES[family];
  if (!e) throw new Error(`Unknown board "${family}".`);
  return {
    type: 'profile', name: 'Estimated positions', family, count: FAMILY_LEDS[family],
    groups: structuredClone(e.groups), leds: structuredClone(e.leds), estimate: true,
  };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function isProfile(p) {
  if (!p || p.type !== 'profile' || !FAMILY_LEDS[p.family] || typeof p.name !== 'string' || !p.name.trim()) return false;
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 32) return false;
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= p.count;
  if (!Array.isArray(p.leds) || !p.leds.length) return false;
  const seen = new Set();
  for (const l of p.leds) {
    if (!l || !inRange(l.led) || !num(l.x) || !num(l.y) || seen.has(l.led)) return false;
    seen.add(l.led);
  }
  if (!p.groups || typeof p.groups !== 'object') return false;
  return Object.values(p.groups).every((g) => Array.isArray(g) && g.every(inRange));
}

// Checks and tidies a profile (used when saving). Throws a sentence saying what to fix.
export function makeProfile(family, name, { count = FAMILY_LEDS[family], groups = {}, leds = [] } = {}) {
  if (!FAMILY_LEDS[family]) throw new Error(`Unknown board "${family}".`);
  const clean = String(name).trim();
  if (!clean) throw new Error('Give the casing a name, like SOTA.');
  const p = {
    type: 'profile', name: clean, family, count,
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...v]])),
    leds: leds.map((l) => ({ led: l.led, x: Number(l.x), y: Number(l.y) })).sort((a, b) => a.led - b.led),
  };
  if (!p.leds.length) throw new Error('Give at least one LED a position.');
  if (!isProfile(p)) throw new Error(`Each LED needs a number from 1 to ${count}, used once, with x and y in mm.`);
  return p;
}

export const profileFileName = (p) => `${slug(p.name)}-${p.family}.json`;

// The group an LED belongs to, or '' when it has none.
export const groupOf = (p, led) => Object.keys(p.groups).find((g) => p.groups[g].includes(led)) || '';

// The LEDs the preview draws, from the plug up. Each is { led, x, y }.
export const drawnLeds = (p) => [...p.leds].sort((a, b) => a.y - b.y || a.x - b.x);
