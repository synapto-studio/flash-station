// The 3D drive: the real casing (a casing model, casing-model.js) with its LEDs lit, drawn with
// WebGL2 and no libraries. Same LED calls as the 2D drawing (js/drive-art.js): setLed(n, rgb, level),
// or setPixels() with what the player's toPixels() gives, so whatever drives the drawing today can
// drive this.
//
//   const d = new Drive3D(canvas, { model: readCasing(bytes), profile });
//   d.setPixels(toPixels(levels(anim, t, ctx)));   // every frame
//
// How it looks: the shell parts are solid, lit by the room and by the LEDs from inside; the resin
// parts are see-through and glow where the LEDs' light spreads through them (a fall-off with
// distance, not a light simulation); each LED is a small bright chip on the board; bright parts
// bloom. Light levels are linear (an LED at 255 is 255 times one at 1), then tone-mapped for the
// screen. Drag to turn it, scroll or pinch to zoom, double-click to go back. With inPage (a view in
// a longer page, like the app's Routines tab) scrolling still scrolls the page: a pinch or Ctrl/⌘ +
// scroll zooms, and a finger moving up or down scrolls.
//
// Twin: the firmware repo's casing/web/drive-3d.js (its preview page). Change both.

import { bounds } from './casing-model.js';

// Which LED sits behind which on the other side of the board (as js/player.js makeDrive).
export const FACING = { core: { 4: 3, 5: 1, 6: 2 }, pulse: { 4: 3, 6: 5, 7: 1, 8: 2 } };
const LED_SIZE = [2.0, 0.84, 2.0];       // WS2812C-2020: 2.0 x 2.0 mm, 0.84 mm tall

// Default looks. colour is linear RGB 0-1. glow: how much of the LEDs' light a part shows from
// inside (resin: most; a solid shell: none, a smoked shell would be a little).
export const DEFAULT_LOOKS = {
  shell:   { colour: [0.035, 0.032, 0.030], rough: 0.55, metal: 0, glow: 0.0, alpha: 1 },
  resin:   { colour: [0.60, 0.42, 0.26], rough: 0.25, metal: 0, glow: 1.0, alpha: 0.30 },
  board:   { colour: [0.010, 0.012, 0.012], rough: 0.6, metal: 0, glow: 0, alpha: 1 },
  metal:   { colour: [0.62, 0.62, 0.64], rough: 0.32, metal: 1, glow: 0, alpha: 1 },
  plastic: { colour: [0.02, 0.02, 0.02], rough: 0.7, metal: 0, glow: 0, alpha: 1 },
  gold:    { colour: [0.85, 0.62, 0.25], rough: 0.3, metal: 1, glow: 0, alpha: 1 },
};

// Where each LED sits in the model, from a drive profile (js/profiles.js: x mm from the centre line,
// y mm above the top of the USB A connector, front LEDs only). LEDs on the back sit behind the one
// they face. Returns [{ led, pos: [x, y, z], side: +1 front / -1 back }], LEDs with no position left out.
export function ledSpots(model, profile) {
  const at = {};
  for (const l of profile.leds) at[l.led] = l;
  const facing = FACING[profile.family] || {};
  const front = model.frontY || 1, half = (model.board?.thickness ?? 1) / 2, by = model.board?.y ?? 0;
  const spots = [];
  for (let n = 1; n <= profile.count; n++) {
    const own = at[n], other = at[facing[n]];
    if (!own && !other) continue;
    const back = !own;
    const l = own || other, side = back ? -front : front;
    spots.push({ led: n, side, pos: [l.x, by + side * (half + LED_SIZE[1] / 2), model.plugTopZ + l.y] });
  }
  return spots;
}

// ---------------------------------------------------------------- small maths (column-major 4x4)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAt(eye, at, up) {
  const f = norm(sub(at, eye)), s = norm(cross(f, up)), u = cross(s, f);
  return [s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0, -dot(s, eye), -dot(u, eye), dot(f, eye), 1];
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// ---------------------------------------------------------------- shaders
const MAX_LEDS = 8;
const COMMON = `#version 300 es
precision highp float;
precision highp int;
#define MAX_LEDS ${MAX_LEDS}
uniform vec3 uEye;
uniform int uLedN;
uniform vec3 uLedPos[MAX_LEDS];
uniform vec3 uLedCol[MAX_LEDS];      // linear light, 0-1 per channel at full
uniform float uLedSide[MAX_LEDS];
uniform float uBoardY;
uniform float uDirect;               // 1: no HDR buffer, tone-map here
uniform float uExposure;
uniform vec3 uKeyDir, uRimDir;   // the room's key and rim lights, turned with the camera
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toScreen(vec3 c) { return pow(aces(c * uExposure), vec3(1.0 / 2.2)); }
vec4 finish(vec3 c, float a) { return uDirect > 0.5 ? vec4(toScreen(c), a) : vec4(c, a); }
// How much of LED i's light reaches point p: the board blocks the far side (softly: light leaks
// round its edges and through the resin).
float sideOf(int i, vec3 p, float leak) { return mix(leak, 1.0, smoothstep(-1.2, 0.4, (p.y - uBoardY) * uLedSide[i])); }
`;

const MESH_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
uniform mat4 uViewProj;
uniform vec3 uMin, uSpan, uOffset;   // a part's box, and how far it has been moved (the cap coming off)
out vec3 vPos;
out vec3 vNrm;
void main() {
  vec3 p = uMin + aPos * uSpan + uOffset;
  vPos = p;
  vNrm = aNrm;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

// Solid parts: the room's light (sky above, floor below, a key light and a rim light), the LEDs'
// light on surfaces that face them, and any glow from inside (a smoked shell).
const SOLID_FS = COMMON + `
in vec3 vPos;
in vec3 vNrm;
uniform vec3 uColour;
uniform float uRough, uMetal, uGlow;
uniform vec3 uEmit;
uniform float uLedPower, uGlowGain, uGlowReach;
out vec4 o;
vec3 lightFrom(vec3 N, vec3 V, vec3 L, vec3 c, vec3 base, float spec) {
  float ndl = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float sh = pow(max(dot(N, H), 0.0), mix(160.0, 12.0, uRough)) * spec;
  return c * (base * ndl * (1.0 - uMetal) + sh * mix(vec3(0.04), base, uMetal) * (2.0 - uRough));
}
void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  vec3 base = uColour;
  float spec = 1.0;
  vec3 sky = vec3(0.30, 0.31, 0.34), floorC = vec3(0.05, 0.045, 0.04);
  vec3 c = base * mix(floorC, sky, N.z * 0.5 + 0.5) * (1.0 - 0.6 * uMetal);
  // a metal part reflects the room: a soft bright band above, dark below
  vec3 R = reflect(-V, N);
  c += uMetal * base * mix(vec3(0.03), vec3(0.9), smoothstep(-0.2, 0.6, R.z)) * 0.6;
  c += lightFrom(N, V, uKeyDir, vec3(1.6), base, spec);
  c += lightFrom(N, V, uRimDir, vec3(0.45, 0.48, 0.55), base, spec);
  for (int i = 0; i < MAX_LEDS; i++) {
    if (i >= uLedN) break;
    vec3 L = uLedPos[i] - vPos;
    float d2 = dot(L, L);
    L *= inversesqrt(d2);
    float k = uLedPower / (d2 + 4.0) * sideOf(i, vPos, 0.0);
    c += lightFrom(N, V, L, uLedCol[i] * k, base, 0.5);
    if (uGlow > 0.0) c += uLedCol[i] * uGlow * uGlowGain * exp(-sqrt(d2) / uGlowReach) * sideOf(i, vPos, 0.25);
  }
  o = finish(c + uEmit, 1.0);
}`;

// See-through resin: a faint tinted surface with a shine at glancing angles, plus the LEDs' light
// spreading through it. Drawn back faces first, then front faces, blended over what's behind.
const RESIN_FS = COMMON + `
in vec3 vPos;
in vec3 vNrm;
uniform vec3 uColour;
uniform float uAlpha, uGlow, uGlowGain, uGlowReach;
out vec4 o;
void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  float fres = pow(1.0 - abs(dot(N, V)), 4.0);
  vec3 sky = vec3(0.30, 0.31, 0.34), floorC = vec3(0.05, 0.045, 0.04);
  vec3 surf = uColour * mix(floorC, sky, N.z * 0.5 + 0.5) * 0.6;
  vec3 L = uKeyDir;
  float sh = pow(max(dot(N, normalize(L + V)), 0.0), 90.0);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < MAX_LEDS; i++) {
    if (i >= uLedN) break;
    float d = length(uLedPos[i] - vPos);
    glow += uLedCol[i] * (exp(-d / uGlowReach) + 0.35 * exp(-d / (uGlowReach * 3.0))) * sideOf(i, vPos, 0.3);
  }
  glow *= uColour / max(max(uColour.r, uColour.g), max(uColour.b, 0.001)) * 0.5 + 0.5;  // the resin's tint, softly
  float a = clamp(uAlpha + fres * 0.5, 0.0, 1.0);
  vec3 c = surf * a + vec3(1.6) * sh * (0.3 + fres) + glow * uGlow * uGlowGain;
  o = finish(c, a);
}`;

// A soft halo round each lit LED, seen through the resin (additive).
const HALO_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uCentre, uRight, uUp;
uniform float uSize;
out vec2 vUv;
void main() {
  vUv = aCorner;
  gl_Position = uViewProj * vec4(uCentre + (uRight * aCorner.x + uUp * aCorner.y) * uSize, 1.0);
}`;
const HALO_FS = COMMON + `
in vec2 vUv;
uniform vec3 uHalo;
out vec4 o;
void main() {
  float r2 = dot(vUv, vUv);
  vec3 c = uHalo * (exp(-r2 * 9.0) * 0.8 + exp(-r2 * 2.5) * 0.2);
  o = uDirect > 0.5 ? vec4(toScreen(c), 0.0) : vec4(c, 0.0);
}`;

// Full-screen passes: bloom (bright parts, blurred) and the final tone map.
const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
out vec2 vUv;
void main() { vUv = aCorner * 0.5 + 0.5; gl_Position = vec4(aCorner, 0.0, 1.0); }`;
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  for (int y = -1; y <= 1; y += 2) for (int x = -1; x <= 1; x += 2) c += texture(uTex, vUv + vec2(x, y) * uTexel * 0.5).rgb;
  c *= 0.25;
  float b = max(max(c.r, c.g), c.b);
  o = vec4(c * max(b - uThreshold, 0.0) / max(b, 1e-4), 1.0);
}`;
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  c += (texture(uTex, vUv + uStep * 1.3846153846).rgb + texture(uTex, vUv - uStep * 1.3846153846).rgb) * 0.3162162162;
  c += (texture(uTex, vUv + uStep * 3.2307692308).rgb + texture(uTex, vUv - uStep * 3.2307692308).rgb) * 0.0702702703;
  o = vec4(c, 1.0);
}`;
const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene, uBloomA, uBloomB;
uniform float uBloom, uExposure;
uniform vec3 uBackground;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec4 s = texture(uScene, vUv);
  vec3 c = s.rgb + (texture(uBloomA, vUv).rgb * 0.6 + texture(uBloomB, vUv).rgb * 0.4) * uBloom;
  c = pow(aces(c * uExposure), vec3(1.0 / 2.2));
  o = vec4(c, 1.0);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`3D view shader: ${gl.getShaderInfoLog(sh)}`);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`3D view shader: ${gl.getProgramInfoLog(prog)}`);
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i), name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ---------------------------------------------------------------- the view
export class Drive3D {
  // options: model (readCasing), profile (js/profiles.js), background ('#rrggbb'), standIns (draw the
  // stand-in parts), looks ({ shell: { colour, glow, ... } } over DEFAULT_LOOKS), inPage (the page
  // scrolls over it: see the top).
  constructor(canvas, { model, profile, background = '#0b0a09', standIns = true, looks = {}, inPage = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser can\'t draw the 3D drive (it needs WebGL2). Use Chrome or Edge.');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.standIns = standIns;
    this.inPage = inPage;
    this.looks = structuredClone(DEFAULT_LOOKS);
    this.setLooks(looks);
    this.setBackground(background);
    this.ledPower = 900;       // how strongly the LEDs light the surfaces round them
    this.glowGain = 0.8;       // how bright the resin glows from the LEDs
    this.glowReach = 4.5;      // mm: how far the glow spreads before it's down to about a third
    this.exposure = 1.0;
    this.bloom = 1.0;
    this.solid = compile(gl, MESH_VS, SOLID_FS);
    this.resin = compile(gl, MESH_VS, RESIN_FS);
    this.halo = compile(gl, HALO_VS, HALO_FS);
    this.bright = compile(gl, QUAD_VS, BRIGHT_FS);
    this.blur = compile(gl, QUAD_VS, BLUR_FS);
    this.final = compile(gl, QUAD_VS, FINAL_FS);
    this.quad = this.makeQuad();
    this.cube = this.makeCube();
    this.parts = [];
    this.spots = [];
    this.pixels = [];
    this.yaw = Math.PI - 0.55; this.pitch = 0.18; this.zoom = 1;   // the big half's side (a real part), from the left
    this.listen();
    if (model) this.setModel(model, profile);
    this.resize();
    this.ro = new ResizeObserver(() => { this.resize(); this.render(); });
    this.ro.observe(canvas);
  }

  setLooks(looks) {
    for (const [k, v] of Object.entries(looks || {})) this.looks[k] = { ...(this.looks[k] || DEFAULT_LOOKS.shell), ...v };
  }

  setBackground(css) {
    const h = css.replace('#', '');
    this.background = [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
  }

  setModel(model, profile = this.profile) {
    const gl = this.gl;
    for (const p of this.parts) { gl.deleteVertexArray(p.vao); for (const b of p.buffers) gl.deleteBuffer(b); }
    this.model = model;
    this.parts = model.parts.map((p) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pos = gl.createBuffer(), nrm = gl.createBuffer(), idx = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, p.position, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, true, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
      gl.bufferData(gl.ARRAY_BUFFER, p.normal, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.index, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const span = p.max.map((v, k) => v - p.min[k]);
      return { ...p, position: null, normal: null, index: null, vao, buffers: [pos, nrm, idx], span, count: p.triangles * 3,
        type: p.indexBytes === 2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, hidden: false, offset: [0, 0, 0] };
    });
    this.fit(true);
    if (profile) this.setProfile(profile);
    this.render();
  }

  setProfile(profile) {
    this.profile = profile;
    this.spots = this.model ? ledSpots(this.model, profile) : [];
    this.pixels = this.spots.map(() => [0, 0, 0]);
    this.render();
  }

  // Parts by name, look ('shell', 'resin', ...) or group ('cap').
  matching(which) { return this.parts.filter((p) => p.name === which || p.look === which || p.group === which); }

  // Show or hide parts. The camera eases to frame what's left.
  show(which, on = true) {
    for (const p of this.matching(which)) p.hidden = !on;
    this.fit();
  }

  // One LED, as js/drive-art.js: rgb 0-255, level 0-1.
  setLed(n, rgb, level = 1) {
    const i = this.spots.findIndex((s) => s.led === Number(n));
    if (i < 0) return;
    this.pixels[i] = rgb.map((c) => c * level);
    this.dirty = true;
  }

  // Every LED at once: px[k] is LED k+1's [r, g, b], 0-255, as sent to the LED (js/player.js toPixels).
  setPixels(px) {
    this.spots.forEach((s, i) => { this.pixels[i] = px[s.led - 1] || [0, 0, 0]; });
    this.dirty = true;
  }

  off() { this.pixels = this.spots.map(() => [0, 0, 0]); this.dirty = true; }

  // Named views: front, back, side, three-quarter, plug (looking up at the plug end).
  view(name) {
    const v = { front: [0, 0.05], back: [Math.PI, 0.05], side: [Math.PI / 2, 0.05], 'three-quarter': [Math.PI - 0.55, 0.18], plug: [-0.4, -1.1], top: [-0.4, 1.2] }[name];
    if (v) [this.yaw, this.pitch] = v;
    this.zoom = 1;
    this.render();
  }

  // ------------------------------------------------------------ drawing
  makeQuad() {
    const gl = this.gl, vao = gl.createVertexArray(), b = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  makeCube() { // a 0..1 box, as a part (positions spread over min..max, like the model's)
    const gl = this.gl, P = [], N = [], I = [];
    const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    for (const [axis, s] of faces) {
      const a = (axis + 1) % 3, b = (axis + 2) % 3, base = P.length / 3;
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const p = [0, 0, 0], n = [0, 0, 0];
        p[axis] = s > 0 ? 65535 : 0; p[a] = u * 65535; p[b] = v * 65535; n[axis] = s * 127;
        P.push(...p); N.push(...n);
      }
      I.push(...(s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((k) => k + base));
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, new Uint16Array(P), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, new Int8Array(N), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(I), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: I.length };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    if (this.hdr) this.makeTargets();
  }

  makeTargets() {
    const gl = this.gl;
    for (const t of this.targets || []) { gl.deleteFramebuffer(t.fb); if (t.tex) gl.deleteTexture(t.tex); for (const r of t.rbs || []) gl.deleteRenderbuffer(r); }
    const tex = (w, h) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      return { fb, tex: t, w, h };
    };
    // the scene, drawn with 4x multisampling, then resolved into a texture
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    const msFb = gl.createFramebuffer(), colour = gl.createRenderbuffer(), depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, this.w, this.h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { this.hdr = false; gl.bindFramebuffer(gl.FRAMEBUFFER, null); return; }
    const ms = { fb: msFb, rbs: [colour, depth] };
    const scene = tex(this.w, this.h);
    const hw = Math.max(1, this.w >> 1), hh = Math.max(1, this.h >> 1), qw = Math.max(1, this.w >> 2), qh = Math.max(1, this.h >> 2);
    const a1 = tex(hw, hh), a2 = tex(hw, hh), b1 = tex(qw, qh), b2 = tex(qw, qh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = [ms, scene, a1, a2, b1, b2];
    Object.assign(this, { ms, scene, a1, a2, b1, b2 });
  }

  // Frames the parts that are showing and in place (a part being moved away doesn't count). The
  // camera eases there over a few frames, or jumps there with now.
  fit(now = false) {
    const shown = this.parts.filter((p) => !p.hidden && (this.standIns || !p.standIn) && !p.offset.some((v) => v));
    const b = bounds({ parts: shown.length ? shown : this.parts });
    this.aim = { centre: [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2), radius: Math.hypot(...[0, 1, 2].map((k) => b.max[k] - b.min[k])) / 2 };
    if (now || !this.centre) { this.centre = [...this.aim.centre]; this.radius = this.aim.radius; }
    if (!this.running) this.render();
  }

  // Moves parts (by name, look or group) by [x, y, z] mm from where they belong; [0, 0, 0] puts them back.
  move(which, offset) {
    for (const p of this.matching(which)) p.offset = [...offset];
    this.fit();
  }

  camera() {
    if (this.aim) {   // ease towards the framing fit() asked for
      const now = performance.now(), dt = Math.min(100, now - (this.lastEase || now));
      this.lastEase = now;
      const k = 1 - Math.exp(-dt / 180);
      this.centre = this.centre.map((v, i) => v + (this.aim.centre[i] - v) * k);
      this.radius += (this.aim.radius - this.radius) * k;
    }
    const dist = (this.radius / Math.sin(0.25)) * 1.12 / this.zoom;
    const cp = Math.cos(this.pitch);
    // yaw 0 looks at the front (+y side, where the profile's front LEDs face), from in front of it
    const front = this.model?.frontY || 1;
    const eye = [this.centre[0] + Math.sin(this.yaw) * cp * dist, this.centre[1] + front * Math.cos(this.yaw) * cp * dist, this.centre[2] + Math.sin(this.pitch) * dist];
    const view = lookAt(eye, this.centre, [0, 0, 1]);
    const proj = perspective(0.5, this.w / this.h, dist * 0.2, dist * 3);
    // lights that turn with the camera: the key from above left and in front, a rim from behind right
    const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]], back = [view[2], view[6], view[10]];
    const mixDir = (a, b, c) => norm([0, 1, 2].map((k) => right[k] * a + up[k] * b + back[k] * c));
    return { eye, view, viewProj: mul(proj, view), key: mixDir(-0.5, 0.7, 0.75), rim: mixDir(0.85, 0.25, -0.5) };
  }

  ledUniforms(u) {
    const gl = this.gl, n = Math.min(MAX_LEDS, this.spots.length);
    gl.uniform1i(u.uLedN, n);
    if (!n) return;
    gl.uniform3fv(u.uLedPos, this.spots.slice(0, n).flatMap((s) => s.pos));
    gl.uniform3fv(u.uLedCol, this.pixels.slice(0, n).flatMap((c) => c.map((v) => v / 255)));
    gl.uniform1fv(u.uLedSide, this.spots.slice(0, n).map((s) => s.side));
    gl.uniform1f(u.uBoardY, this.model.board?.y ?? 0);
  }

  common(u, cam) {
    const gl = this.gl;
    gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
    gl.uniform3fv(u.uEye, cam.eye);
    gl.uniform1f(u.uDirect, this.hdr ? 0 : 1);
    gl.uniform1f(u.uExposure, this.exposure);
    gl.uniform3fv(u.uKeyDir, cam.key);
    gl.uniform3fv(u.uRimDir, cam.rim);
    this.ledUniforms(u);
  }

  drawPart(p, u) {
    const gl = this.gl;
    gl.uniform3fv(u.uMin, p.min);
    gl.uniform3fv(u.uSpan, p.span);
    gl.uniform3fv(u.uOffset, p.offset);
    gl.bindVertexArray(p.vao);
    gl.drawElements(gl.TRIANGLES, p.count, p.type, 0);
  }

  render() {
    if (!this.model || !this.w) return;
    const gl = this.gl, cam = this.camera();
    this.dirty = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr ? this.ms.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    const bg = this.hdr ? this.background : this.background.map((c) => c ** (1 / 2.2));
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    const visible = this.parts.filter((p) => !p.hidden && (this.standIns || !p.standIn));

    // 1. solid parts, and the LED chips
    const s = this.solid, su = s.u;
    gl.useProgram(s.prog);
    this.common(su, cam);
    gl.uniform1f(su.uLedPower, this.ledPower);
    gl.uniform1f(su.uGlowGain, this.glowGain);
    gl.uniform1f(su.uGlowReach, this.glowReach);
    gl.disable(gl.CULL_FACE);
    for (const p of visible) {
      if (p.look === 'resin') continue;
      const L = this.looks[p.look] || DEFAULT_LOOKS.shell;
      gl.uniform3fv(su.uColour, L.colour);
      gl.uniform1f(su.uRough, L.rough);
      gl.uniform1f(su.uMetal, L.metal);
      gl.uniform1f(su.uGlow, L.glow || 0);
      gl.uniform3fv(su.uEmit, [0, 0, 0]);
      this.drawPart(p, su);
    }
    gl.uniform1i(su.uLedN, 0);
    gl.uniform1f(su.uGlow, 0);
    gl.uniform1f(su.uRough, 0.3);
    gl.uniform1f(su.uMetal, 0);
    this.spots.forEach((sp, i) => {
      const c = this.pixels[i].map((v) => v / 255);
      gl.uniform3fv(su.uColour, [0.75, 0.75, 0.72]);
      gl.uniform3fv(su.uEmit, c.map((v) => v * 40));
      gl.uniform3fv(su.uMin, sp.pos.map((v, k) => v - LED_SIZE[k] / 2));
      gl.uniform3fv(su.uSpan, LED_SIZE);
      gl.uniform3fv(su.uOffset, [0, 0, 0]);
      gl.bindVertexArray(this.cube.vao);
      gl.drawElements(gl.TRIANGLES, this.cube.count, gl.UNSIGNED_SHORT, 0);
    });

    // 2. halos round lit LEDs (added on, hidden by solid parts in front)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    const h = this.halo, hu = h.u;
    gl.useProgram(h.prog);
    gl.uniformMatrix4fv(hu.uViewProj, false, cam.viewProj);
    gl.uniform1f(hu.uDirect, this.hdr ? 0 : 1);
    gl.uniform1f(hu.uExposure, this.exposure);
    const v = cam.view, right = [v[0], v[4], v[8]], up = [v[1], v[5], v[9]];
    gl.uniform3fv(hu.uRight, right);
    gl.uniform3fv(hu.uUp, up);
    gl.bindVertexArray(this.quad);
    this.spots.forEach((sp, i) => {
      const c = this.pixels[i].map((x) => x / 255), lvl = Math.max(...c);
      if (lvl <= 0) return;
      const toEye = norm(sub(cam.eye, sp.pos));
      const facing = Math.max(0, toEye[1] * sp.side) * 0.75 + 0.25;   // brighter seen from the LED's own side
      gl.uniform3fv(hu.uCentre, sp.pos.map((x, k) => x + toEye[k] * 1.5));
      gl.uniform1f(hu.uSize, 6 + 4 * Math.sqrt(lvl));
      gl.uniform3fv(hu.uHalo, c.map((x) => x * 2.2 * facing));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });

    // 3. resin: back faces, then front faces, blended over
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const r = this.resin, ru = r.u;
    gl.useProgram(r.prog);
    this.common(ru, cam);
    gl.uniform1f(ru.uGlowGain, this.glowGain);
    gl.uniform1f(ru.uGlowReach, this.glowReach);
    gl.enable(gl.CULL_FACE);
    for (const face of [gl.FRONT, gl.BACK]) {
      gl.cullFace(face);
      for (const p of visible) {
        if (p.look !== 'resin') continue;
        const L = this.looks.resin;
        gl.uniform3fv(ru.uColour, L.colour);
        gl.uniform1f(ru.uAlpha, L.alpha);
        gl.uniform1f(ru.uGlow, L.glow);
        this.drawPart(p, ru);
      }
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.bindVertexArray(null);
    if (this.hdr) this.post();
  }

  post() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ms.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scene.fb);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindVertexArray(this.quad);
    const pass = (prog, target, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
      gl.useProgram(prog.prog);
      setup(prog.u);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const bind = (u, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform1i(u[name], unit); };
    pass(this.bright, this.a1, (u) => { bind(u, 'uTex', 0, this.scene); gl.uniform2f(u.uTexel, 1 / this.w, 1 / this.h); gl.uniform1f(u.uThreshold, 0.9); });
    const blur = (src, tmp, dst, w, h, k) => {
      pass(this.blur, tmp, (u) => { bind(u, 'uTex', 0, src); gl.uniform2f(u.uStep, k / w, 0); });
      pass(this.blur, dst, (u) => { bind(u, 'uTex', 0, tmp); gl.uniform2f(u.uStep, 0, k / h); });
    };
    blur(this.a1, this.a2, this.a1, this.a1.w, this.a1.h, 1);
    pass(this.blur, this.b1, (u) => { bind(u, 'uTex', 0, this.a1); gl.uniform2f(u.uStep, 0, 0); });
    blur(this.b1, this.b2, this.b1, this.b1.w, this.b1.h, 1.5);
    blur(this.b1, this.b2, this.b1, this.b1.w, this.b1.h, 2.5);
    pass(this.final, null, (u) => {
      bind(u, 'uScene', 0, this.scene); bind(u, 'uBloomA', 1, this.a1); bind(u, 'uBloomB', 2, this.b1);
      gl.uniform1f(u.uBloom, this.bloom); gl.uniform1f(u.uExposure, this.exposure);
    });
    gl.enable(gl.DEPTH_TEST);
  }

  // Keeps drawing every frame; onFrame(ms) runs first (set the LEDs there). Returns a stop function.
  run(onFrame) {
    let id = 0;
    const tick = (t) => { if (onFrame) onFrame(t); this.render(); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    this.running = true;
    this.stop = () => { cancelAnimationFrame(id); this.running = false; };
    return this.stop;
  }

  // ------------------------------------------------------------ turning and zooming
  listen() {
    const c = this.canvas, down = new Map();
    let pinch = 0;
    c.style.touchAction = this.inPage ? 'pan-y' : 'none';
    c.addEventListener('pointerdown', (e) => { down.set(e.pointerId, [e.clientX, e.clientY]); c.setPointerCapture(e.pointerId); this.touched = true; });
    c.addEventListener('pointermove', (e) => {
      const was = down.get(e.pointerId);
      if (!was) return;
      down.set(e.pointerId, [e.clientX, e.clientY]);
      if (down.size === 1) {
        this.yaw += (e.clientX - was[0]) * 0.008;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (e.clientY - was[1]) * 0.008));
      } else if (down.size === 2) {
        const [a, b] = [...down.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.zoom = Math.max(0.6, Math.min(5, this.zoom * d / pinch));
        pinch = d;
      }
      this.render();
    });
    const up = (e) => { down.delete(e.pointerId); pinch = 0; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      if (this.inPage && !e.ctrlKey && !e.metaKey) return;   // the page scrolls (a trackpad pinch comes with ctrlKey)
      e.preventDefault(); this.zoom = Math.max(0.6, Math.min(5, this.zoom * Math.exp(-e.deltaY * 0.0015))); this.render(); }, { passive: false });
    c.addEventListener('dblclick', () => this.view('three-quarter'));
  }

  dispose() {
    if (this.stop) this.stop();
    this.ro.disconnect();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
