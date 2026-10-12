// The drive drawing on the Initialise tab. Its LEDs mirror what's happening at the pins:
// white filling up from the plug while it writes (as the pulsetest bootloader does on a
// real drive), the routine's steady colours when it's done, LED 1 blinking red on a fault.

const NS = 'http://www.w3.org/2000/svg';

// LED positions (x, y) in the drawing, and the order they fill from the plug end.
const LAYOUTS = {
  pulse: {
    leds: { 1: [70, 290], 2: [90, 290], 7: [110, 290], 8: [130, 290], 3: [80, 186], 4: [120, 186], 5: [80, 84], 6: [120, 84] },
    fill: [1, 8, 2, 7, 3, 4, 5, 6],
    section: { 1: 'bottom', 2: 'bottom', 7: 'bottom', 8: 'bottom', 3: 'middle', 4: 'middle', 5: 'top', 6: 'top' },
  },
  core: {
    leds: { 1: [80, 290], 2: [120, 290], 3: [80, 186], 4: [120, 186], 5: [80, 84], 6: [120, 84] },
    fill: [1, 2, 3, 4, 5, 6],
    section: { 1: 'outer', 2: 'outer', 5: 'outer', 6: 'outer', 3: 'inner', 4: 'inner' },
  },
};

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class DriveArt {
  constructor(svg) {
    this.svg = svg;
    this.family = 'pulse';
    this.build();
  }

  setFamily(family) {
    if (family === this.family) return;
    this.family = family;
    this.build();
  }

  build() {
    const s = this.svg;
    s.replaceChildren();
    s.setAttribute('viewBox', '0 0 236 420');
    const defs = el('defs', {}, s);
    const grad = el('linearGradient', { id: 'resin', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0', 'stop-color': 'var(--resin)', 'stop-opacity': '0.20' }, grad);
    el('stop', { offset: '1', 'stop-color': 'var(--resin)', 'stop-opacity': '0.07' }, grad);
    const f = el('filter', { id: 'glow', x: '-1', y: '-1', width: '3', height: '3' }, defs);
    el('feGaussianBlur', { stdDeviation: '7' }, f);

    // Shell, resin window, plug
    el('rect', { x: 36, y: 14, width: 128, height: 334, rx: 30, class: 'art-shell' }, s);
    el('rect', { x: 50, y: 28, width: 100, height: 306, rx: 20, fill: 'url(#resin)', class: 'art-window' }, s);
    el('rect', { x: 68, y: 348, width: 64, height: 60, rx: 3, class: 'art-plug' }, s);
    el('rect', { x: 76, y: 360, width: 48, height: 26, rx: 1, class: 'art-plug-inner' }, s);
    el('rect', { x: 84, y: 366, width: 9, height: 8, class: 'art-plug-hole' }, s);
    el('rect', { x: 107, y: 366, width: 9, height: 8, class: 'art-plug-hole' }, s);

    const lay = LAYOUTS[this.family];
    const label = (y, text) => {
      const t = el('text', { x: 172, y: y + 4, class: 'art-label' }, s);
      t.textContent = text;
    };
    label(84, 'top');
    label(186, this.family === 'pulse' ? 'middle' : 'inner');
    label(290, 'plug end');

    this.leds = {};
    for (const [n, [x, y]] of Object.entries(lay.leds)) {
      const g = el('g', { class: 'led', 'data-led': n }, s);
      const glow = el('circle', { cx: x, cy: y, r: 15, filter: 'url(#glow)', class: 'led-glow' }, g);
      el('rect', { x: x - 6, y: y - 6, width: 12, height: 12, rx: 2, class: 'led-pkg' }, g);
      const core = el('circle', { cx: x, cy: y, r: 3.5, class: 'led-core' }, g);
      this.leds[n] = { g, glow, core };
    }
    this.off();
  }

  setLed(n, rgb, level) {
    const led = this.leds[n];
    if (!led) return;
    const c = `rgb(${rgb.join(',')})`;
    led.glow.setAttribute('fill', c);
    led.glow.setAttribute('opacity', (level * 0.95).toFixed(3));
    led.core.setAttribute('fill', level > 0.02 ? c : 'var(--led-off)');
    led.core.setAttribute('opacity', level > 0.02 ? (0.45 + level * 0.55).toFixed(3) : '1');
  }

  mode(name) {
    this.svg.dataset.mode = name || '';
  }

  off() {
    this.mode('');
    for (const n of Object.keys(this.leds)) this.setLed(n, [0, 0, 0], 0);
  }

  checking() {
    this.off();
    this.mode('checking');
    for (const n of Object.keys(this.leds)) this.setLed(n, [255, 138, 42], 0.5);
  }

  // Fill white from the plug end, like the bootloader's own progress display.
  progress(fraction) {
    this.mode('');
    const order = LAYOUTS[this.family].fill;
    const exact = Math.max(0, Math.min(1, fraction)) * order.length;
    order.forEach((n, i) => {
      const lvl = Math.max(0, Math.min(1, exact - i));
      if (lvl > 0) this.setLed(n, [255, 244, 228], 0.25 + 0.75 * lvl);
      else this.setLed(n, [255, 40, 20], 0.22);
    });
  }

  // The steady look from a set of settings (a still frame, not the animation).
  steady(settings) {
    this.mode('');
    const lay = LAYOUTS[this.family];
    const b = (settings && settings.brightness != null ? settings.brightness : 255) / 255;
    const red = (settings && settings.red) || [255, 0, 0];
    const orange = (settings && settings.orange) || [255, 45, 0];
    const mixed = red.map((c, i) => Math.round((c + orange[i]) / 2));
    for (const n of Object.keys(this.leds)) {
      const sec = lay.section[n];
      let rgb = red, lvl = 0.8;
      if (this.family === 'pulse') {
        if (sec === 'bottom') [rgb, lvl] = [mixed, (settings?.bottomLevel ?? 170) / 255];
        if (sec === 'middle') lvl = (settings?.middleLevel ?? 80) / 255;
        if (sec === 'top') lvl = (settings?.topHigh ?? 215) / 255;
      } else if (sec === 'outer') rgb = mixed;
      this.setLed(n, rgb, Math.max(0.15, lvl * b));
    }
  }

  fault() {
    this.off();
    this.mode('fault');
    this.setLed(1, [255, 30, 20], 0.9);
  }
}
