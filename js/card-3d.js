// The Flash Station drive card in 3D (firmware repo roadmap task 11b). When the drive's profile
// (its casing code and board, from the register) names a casing model, the card shows the drive in
// its real casing instead of the drawing, playing what the real drive plays from the moment it went
// into the box, so the two stay in step: the box reports a Pulse ~1.27 s after plug-in, and from
// there the card plays DriveShow.station(t) (the end of the white pulse, the fade into the resting
// glow, the heartbeats with the box). No model, or no WebGL2: today's drawing.
//
// stationLook() is the drive's side, and needs no page (test/card3d.test.mjs). Simulated only:
// nothing here has been compared with a real drive in the box yet.

import { Drive3D } from './drive-3d.js';
import { DriveShow, defaultShow, unpackShow } from './show.js';
import { Show, makeDrive } from './player.js';
import * as A from './animations.js';
import * as pulse from './preview-pulse.js';
import * as core from './preview-core.js';
import { engineToPreview } from './routines.js';
import { defaultProfile } from './profiles.js';
import { steadyLeds } from './drive-art.js';

// How long after plug-in the box reports a drive (ms): a Pulse when the box stops listening (1.27 s,
// station 0.4 on); a Core once 3 copies of its ID are in (it starts at ~210 ms, 90 ms a copy).
export const REPORT_MS = { pulse: 1270, core: 490 };
// Drives that don't join the box's plug-in animation start their own lighting about then: a Pulse
// whose bootloader introduces it (the demos, pulsetest before 1.5) after its red wait (~1.7 s,
// simulated), a Core straight after its ID (coretest 1.5: it doesn't join the shared animation yet).
export const OWN_FROM_MS = { pulse: 1700, core: 490 };

const version = (label) => {
  const v = /(\d+)\.(\d+)/.exec(label || '');
  return v ? Number(v[1]) * 1000 + Number(v[2]) : null;
};

// What the drive's LEDs show at t ms after it went into the box. drive: its register record (board,
// engine label, settings); engine: the engine file it runs, if the library has it; profile: its
// drive profile. Returns { at(t) → [[r, g, b] × the LED count], joins (it plays the box's plug-in
// animation, in step), what (in words) }.
export function stationLook({ family, drive = null, engine = null, profile = defaultProfile(family) }) {
  const settings = (drive && drive.settings) || (engine && engine.defaults) || null;
  const leds = makeDrive(profile);
  const n = profile.count;
  const all = (rgb) => Array.from({ length: n }, () => [...rgb]);
  if (family === 'core') {
    const C = settings ? engineToPreview('core', core.DEFAULTS, settings) : core.DEFAULTS;
    const own = new Show({ sections: [A.coreEngine(C), A.coreDrift(C)], drive: leds, colours: { red: C.RED, orange: C.ORANGE, white: C.WHITE, yellow: C.YELLOW }, brightness: C.BRIGHTNESS });
    const from = OWN_FROM_MS.core;
    return { joins: false, what: 'its own lighting (a Core doesn\'t join the box\'s animation yet)', at: (t) => (t < from ? all([255, 255, 255]) : own.frame(t - from)) };
  }
  // Pulse. Engine 2 plays its show (what's on the drive); before it, today's looks.
  let show = null;
  if (engine && engine.layout === 2 && engine.show && engine.show.length) {
    try { show = unpackShow(engine.show); } catch { show = null; }
  }
  const label = (drive && drive.engine && drive.engine.label) || (engine && engine.label) || '';
  const v = version(label);
  // pulsetest 1.5 on and engine 2 from 2.5 join the box's plug-in animation; the demos (2.1-2.4)
  // and older engines don't (their bootloader introduces them). An engine 2 the library doesn't
  // have: by its version.
  const joins = show ? !!(show.plugin && show.heartbeat) : v === null || (v >= 1005 && (v < 2000 || v >= 2005));
  if (joins) {
    const ds = new DriveShow(show && show.plugin ? show : defaultShow(pulse.DEFAULTS, profile));
    return {
      joins: true,
      what: 'the plug-in animation with the box',
      at: (t) => {
        const px = ds.station(Math.max(0, Math.floor(t)));
        return n === px.length ? px : px.slice(0, n);
      },
    };
  }
  const P = settings ? engineToPreview('pulse', pulse.DEFAULTS, settings) : pulse.DEFAULTS;
  const sections = show && show.startup && show.ambient ? [show.startup, show.ambient] : [A.pulseStartup(P), A.pulseAmbient(P)];
  const own = new Show({ sections, drive: leds, colours: { red: P.red, orange: P.orange, white: P.white }, brightness: P.brightness });
  const from = OWN_FROM_MS.pulse, red = (P.red || [255, 0, 0]).map((c) => Math.round(c * 0.5));
  return { joins: false, what: 'its own start-up, then its lighting (it doesn\'t join the box\'s animation)', at: (t) => (t < from ? all(red) : own.frame(t - from)) };
}

// The card's picture: the 3D drive on a canvas, or the drawing (DriveArt on an svg).
//   card (the card, data-3d while it's in 3D), canvas, art (a DriveArt), note (a <p> that says
//   which and why), casings (CasingModels, js/library.js), library () => the Library or null.
export class Card3D {
  constructor({ card, canvas, art, note, casings, library }) {
    Object.assign(this, { card, canvas, art, note, casings, library });
    this.view = null;
    this.turn = 0;
    this.look = null;
    this.plugAt = null;
    this.seen = true;
    this.failed = '';
  }

  // what: { family, drive (register record) or null, engine or null, plugAt (performance.now() at
  // plug-in, or null: picked in the list or found by a hello), inSocket, gone }.
  async show(what) {
    const turn = ++this.turn;
    const { family, drive } = what;
    let name = null, profile = defaultProfile(family);
    const lib = this.library();
    if (drive && lib) {
      try { profile = await lib.profileFor(drive.casing, family); } catch { profile = defaultProfile(family); }
      name = profile.model || null;
    }
    if (turn !== this.turn) return;
    if (!name || this.failed) return this.drawing(what, this.failed || '');
    let model;
    try {
      model = await this.casings.open(name);
    } catch (e) {
      if (turn === this.turn) this.drawing(what, `${e.message} Showing the drawing.`);
      return;
    }
    if (turn !== this.turn) return;
    try {
      if (!this.view) {
        this.view = new Drive3D(this.canvas, { model, profile, background: '#2c2724', inPage: true });
        this.watchScreen();
      } else if (this.view.model !== model) this.view.setModel(model, profile);
      else this.view.setProfile(profile);
    } catch (e) {
      this.failed = `${e.message} Showing the drawing.`;
      this.view = null;
      return this.drawing(what, this.failed);
    }
    this.canvas.hidden = false;
    this.art.svg.toggleAttribute('hidden', true);   // an svg has no .hidden
    this.card.toggleAttribute('data-3d', true);
    const v = this.view;
    v.show('cap', !what.inSocket);   // the cap comes off to plug it in
    v.fit(true);
    const playing = what.plugAt != null && !what.gone;
    this.look = playing ? stationLook({ family, drive, engine: what.engine, profile }) : null;
    this.plugAt = playing ? what.plugAt : null;
    const casing = `${model.name || name}${model.model ? `, model ${model.model}` : ''}`;
    if (what.gone) {
      v.off();
      this.say(`3D: ${casing}. Unplugged, so its LEDs are off.`);
    } else if (playing) {
      this.say(`3D: ${casing}, playing ${this.look.what} from the moment it went in (simulated: how the light spreads is a guess). Drag to turn it.`);
    } else {
      for (const [n, rgb, lvl] of steadyLeds(family, drive && drive.settings)) v.setLed(n, rgb, lvl);
      this.say(`3D: ${casing}, in its steady colours. ${what.inSocket ? 'The station has talked to it since it went in, so the card no longer knows where its animation is: unplug it and plug it in again to see it in step.' : 'Plug it into the box to see it play in step with the real drive.'} Drag to turn it.`);
    }
    this.loop();
  }

  // The drawing, as before 3D. why: a sentence for the note, or ''.
  drawing(what, why) {
    this.stop();
    this.look = null;
    this.canvas.hidden = true;
    this.art.svg.toggleAttribute('hidden', false);
    this.card.toggleAttribute('data-3d', false);
    this.art.setFamily(what.family === 'core' ? 'core' : 'pulse');
    if (what.gone) this.art.off();
    else this.art.steady(what.drive ? what.drive.settings : null);
    this.say(why);
  }

  say(text) {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  // Plays while it's playing and on screen (not on another tab or scrolled away).
  loop() {
    const v = this.view;
    if (!v) return;
    const want = !!this.look && this.seen && !this.canvas.hidden;
    if (want && !v.running) v.run(() => this.frame());
    else if (!want && v.running) v.stop();
    if (!v.running) { if (this.look) this.frame(); v.render(); }
  }

  frame() {
    if (this.look && this.view) this.view.setPixels(this.look.at(performance.now() - this.plugAt));
  }

  stop() {
    if (this.view && this.view.running) this.view.stop();
  }

  watchScreen() {
    new IntersectionObserver((seen) => {
      this.seen = seen.some((e) => e.isIntersecting);
      this.loop();
    }).observe(this.canvas);
  }
}
