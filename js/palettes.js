// Colour sets (palettes): a named group of the colours one family's engine uses, saved in the
// library's palettes/ folder. A Core set holds WHITE, RED, YELLOW, ORANGE; a Pulse set holds
// white, red, orange. Colours are [r, g, b], 0-255.

export const COLOUR_KEYS = {
  core: ['WHITE', 'RED', 'YELLOW', 'ORANGE'],
  pulse: ['white', 'red', 'orange'],
};

export function paletteFileName(name) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Give the colour set a name.');
  return `${slug}.json`;
}

// Takes the colours out of the current settings.
export function makePalette(family, name, settings) {
  const keys = COLOUR_KEYS[family];
  if (!keys) throw new Error(`Unknown board "${family}".`);
  const clean = String(name).trim();
  if (!clean) throw new Error('Give the colour set a name.');
  return { name: clean, family, colours: Object.fromEntries(keys.map((k) => [k, [...settings[k]]])) };
}

export function isPalette(p) {
  const keys = p && COLOUR_KEYS[p.family];
  return !!keys && typeof p.name === 'string' && !!p.colours &&
    keys.every((k) => Array.isArray(p.colours[k]) && p.colours[k].length === 3 && p.colours[k].every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
}

// Returns new settings with the palette's colours on top. Everything else is left alone.
export function applyPalette(family, settings, palette) {
  if (!isPalette(palette) || palette.family !== family) throw new Error(`"${palette && palette.name}" is not a ${family === 'core' ? 'Core' : 'Pulse'} colour set.`);
  const out = { ...settings };
  for (const k of COLOUR_KEYS[family]) out[k] = [...palette.colours[k]];
  return out;
}
