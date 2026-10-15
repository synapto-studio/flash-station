// Pulse preview maths: a line-for-line port of the engine in reference/SOTA Pulse Preview.html
// (itself a port of the Pulse firmware, integer maths, same results). Used by the Routines tab.
// Stage 1 = room, mic, ADC, filters, auto-range. Stage 2 = hit detection, tempo grid and the lights.
// Do not tidy the maths: test/preview.test.mjs checks it against the reference page.

const PulseEngine = (function () {
  var FS_HZ = 5000, ACC_N = 16, BLOCK_SAMPLES = 64, BLOCK_MS_X100 = 1280, UV_DIV = 1049;
  var KICK_SHIFT = 2, DC_SHIFT = 10, FOLLOW_BLOCKS = 2, VDD_MV = 3300;
  var REF_MV = [1100, 1500, 2500, VDD_MV], NUM_RANGES = 4;
  var fl = Math.floor, tr = Math.trunc;

  var DEFAULTS = {
    brightness: 255, white: [255, 235, 200], red: [255, 0, 0], orange: [255, 45, 0],
    riseMs: 1200, topPulseMs: 1000, multiMs: 2000, pourMs: 1000, whiteMs: 2000, drainMs: 800, flowMs: 1000,
    topPulses: 3, glowLevel: 150,
    bottomLevel: 170, middleLevel: 80, topHigh: 215, topLow: 180, cycleBars: 4,
    bpmX10: 1740, bpmMin: 165, bpmMax: 180, leadMs: 20,
    micTrimDb: 0, loudTop: 85, loudMiddle: 95, loudBottom: 100,
    kickFadeMs: 160, kickMin: 90,
    kickJumpX10: 14, kickLoudX10: 15, kickMinPct: 45, kickFloorUv: 200, kickGapMs: 150,
    snareJumpX10: 16, snareLoudX10: 35, snareMinPct: 50, snareFloorUv: 20
  };

  /* ---------- the room and the mic (as in the Beat preview) ---------- */
  function musicRms(x, sr) {
    var w = sr, r = [];
    for (var i = 0; i + w <= x.length; i += w) {
      var s = 0; for (var j = i; j < i + w; j++) s += x[j] * x[j];
      r.push(Math.sqrt(s / w));
    }
    if (!r.length) { var s2 = 0; for (var k = 0; k < x.length; k++) s2 += x[k] * x[k]; return Math.sqrt(s2 / Math.max(1, x.length)) || 1e-6; }
    r.sort(function (a, b) { return a - b; });
    var top = r.slice(fl(r.length / 2));
    return top[fl(top.length / 2)] || 1e-6;
  }
  var ROOMS = {
    silence: { spl: 0,   hp: [] },
    home:    { spl: 80,  hp: [[50, 0.7071]] },
    bar:     { spl: 88,  hp: [[40, 0.7071]] },
    club:    { spl: 97,  hp: [] },
    rig:     { spl: 104, hp: [] }
  };
  function hpInPlace(x, sr, f, q) {
    var w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    var a0 = 1 + al, b0 = (1 + cs) / 2 / a0, b1 = -(1 + cs) / a0, b2 = b0, a1 = -2 * cs / a0, a2 = (1 - al) / a0;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) {
      var xi = x[i], v = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = v; x[i] = v;
    }
  }
  // Track -> mic output volts, with `preroll` seconds of room noise first (the drive is plugged
  // in at time 0; the music starts preroll seconds later).
  function micVolts(track, sr, room, preroll, seed) {
    var R = ROOMS[room], pre = fl(preroll * sr), n = pre + track.length;
    var p = new Float32Array(n);
    if (room !== 'silence') p.set(track, pre);
    for (var h = 0; h < R.hp.length; h++) hpInPlace(p, sr, R.hp[h][0], R.hp[h][1]);
    var gain = room === 'silence' ? 0 : 20e-6 * Math.pow(10, R.spl / 20) / musicRms(p.subarray(pre), sr);
    var rnd = mulberry(seed || 7), NT = 8192, tab = new Float32Array(NT), noisePa = 20e-6 * Math.pow(10, 38 / 20);
    for (var q = 0; q < NT; q++) tab[q] = noisePa * gauss(rnd);
    for (var i = 0; i < n; i++) p[i] = p[i] * gain + tab[(i * 2749) & (NT - 1)];
    hpInPlace(p, sr, 50, 0.5);
    var aop = 20e-6 * Math.pow(10, 122 / 20) * Math.SQRT2, S = Math.pow(10, -38 / 20), bias = 0.9;
    for (var k = 0; k < n; k++) {
      var vv = bias + S * aop * Math.tanh(p[k] / aop);
      p[k] = vv < 0 ? 0 : vv > 3.3 ? 3.3 : vv;
    }
    return p;
  }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(6.283185307 * r()); }

  /* ---------- stage 1: ADC, filters, auto-range (processBlock's ranging) ---------- */
  function stage1(volts, sr, opts) {
    opts = opts || {};
    var convDt = 10.4e-6, t0 = 0.16, rec = opts.record ? [] : null;
    var NT = 4096, ntab = new Float32Array(NT), rnd = mulberry(12345);
    for (var q = 0; q < NT; q++) ntab[q] = 0.5 * gauss(rnd);
    var np = 0;
    function vAt(t) {
      var f = t * sr, fr = Math.round(f); if (Math.abs(f - fr) < 1e-6) f = fr;
      var i = fl(f);
      if (i >= volts.length - 1) return volts[volts.length - 1];
      var a = f - i;
      return a < 1e-9 ? volts[i] : volts[i] + (volts[i + 1] - volts[i]) * a;
    }
    var curRef = 3.3;
    function adc10(v) {
      var c = fl(v / curRef * 1024 + ntab[(np = (np + 2749) & (NT - 1))]);
      return c < 0 ? 0 : c > 1023 ? 1023 : c;
    }
    function hwSetRange(r) { curRef = REF_MV[r] / 1000; }
    var tt = 0.15, sum = 0;
    for (var r4 = 0; r4 < 4; r4++) { var a64 = 0; for (var j = 0; j < 64; j++) { a64 += adc10(vAt(tt)); tt += convDt; } sum += a64; }
    var bias = fl(fl(sum / 4) * VDD_MV / 65472);
    var rangeMin = NUM_RANGES - 1, rangeMax = NUM_RANGES - 1, rangeNow;
    for (var r = 0; r < NUM_RANGES; r++) if (REF_MV[r] >= bias + 200) { rangeMin = r; break; }
    for (r = rangeMin; r < NUM_RANGES; r++) if (REF_MV[r] >= 2 * bias) { rangeMax = r; break; }
    rangeNow = rangeMax;
    hwSetRange(rangeNow);
    var F = { dc: 0, lp1: 0, lp2: 0, hp1: 0, hp2: 0, sumKick: 0, sumSnare: 0, sumAll: 0, accMax: 0, accMin: 0xFFFF, n: 0, skip: 0 };
    function readAcc(t) { var a = 0; for (var j = 0; j < ACC_N; j++) a += adc10(vAt(t + j * convDt)); return a; }
    var acc0 = readAcc(t0);
    F.dc = acc0 << 16;
    if (rec) rec.push(bias, acc0);
    var dur = volts.length / sr, nTicks = fl((dur - t0 - 0.001) * FS_HZ);
    var cap = fl(nTicks / BLOCK_SAMPLES) + 2;
    var out = { t: new Float64Array(cap), now: new Uint32Array(cap), eKick: new Float64Array(cap), eSnare: new Float64Array(cap),
                eAll: new Float64Array(cap), ok: new Uint8Array(cap), range: new Uint8Array(cap), n: 0, bias: bias, rec: rec };
    var peakMv = 0, rangeHold = 0, muteBlocks = 80, skipNext = 0;
    for (var tick = 0; tick < nTicks; tick++) {
      if (skipNext) { skipNext = 0; if (rec) rec.push(-1); continue; }    // tick lost to the LED update
      var acc = readAcc(t0 + tick / FS_HZ);
      if (rec) rec.push(acc);
      if (F.skip) { F.skip--; acc = F.dc >> 16; }
      var s = acc << 16;
      F.dc += (s - F.dc) >> DC_SHIFT;
      var x = (s - F.dc) >> 8;
      F.lp1 += (x - F.lp1) >> KICK_SHIFT;
      F.lp2 += (F.lp1 - F.lp2) >> KICK_SHIFT;
      var k = F.lp2;
      F.hp1 += (x - F.hp1) >> 1;
      var h = x - F.hp1;
      F.hp2 += (h - F.hp2) >> 1;
      h -= F.hp2;
      F.sumKick += k < 0 ? -k : k;
      F.sumSnare += h < 0 ? -h : h;
      F.sumAll += x < 0 ? -x : x;
      if (acc > F.accMax) F.accMax = acc;
      if (acc < F.accMin) F.accMin = acc;
      if (++F.n < BLOCK_SAMPLES) continue;
      var bKick = F.sumKick, bSnare = F.sumSnare, bAll = F.sumAll, bMax = F.accMax, bMin = F.accMin;
      F.n = 0; F.sumKick = F.sumSnare = F.sumAll = 0; F.accMax = 0; F.accMin = 0xFFFF;
      var dcAcc = F.dc >> 16;
      var up = bMax > dcAcc ? bMax - dcAcc : 0, dn = dcAcc > bMin ? dcAcc - bMin : 0;
      var swingMv = fl((up > dn ? up : dn) * REF_MV[rangeNow] / (1024 * ACC_N)) & 0xFFFF;
      if (swingMv > peakMv) peakMv = swingMv; else if (peakMv) peakMv -= (peakMv >> 7) + 1;
      if (rangeHold) rangeHold--;
      var changeTo = rangeNow;
      if (bMax >= ACC_N * 1016 && rangeNow < rangeMax) { changeTo = rangeNow + 1; rangeHold = 300; }
      else if (rangeNow > rangeMin && !rangeHold && peakMv * 2 < headroom(rangeNow - 1)) { changeTo = rangeNow - 1; rangeHold = 100; }
      var i = out.n++;
      out.t[i] = t0 + (tick + 1) / FS_HZ;
      out.now[i] = fl(out.t[i] * 1000);
      out.eKick[i] = fl(fl(bKick / 256) * REF_MV[rangeNow] / UV_DIV);
      out.eSnare[i] = fl(fl(bSnare / 256) * REF_MV[rangeNow] / UV_DIV);
      out.eAll[i] = fl(fl(bAll / 256) * REF_MV[rangeNow] / UV_DIV);
      out.ok[i] = muteBlocks === 0 ? 1 : 0;
      if (muteBlocks) muteBlocks--;
      out.range[i] = rangeNow;
      if (changeTo !== rangeNow) {
        var qf = fl((REF_MV[rangeNow] << 14) / REF_MV[changeTo]);
        hwSetRange(changeTo);
        F.dc = rescale(F.dc, qf); F.lp1 = rescale(F.lp1, qf); F.lp2 = rescale(F.lp2, qf);
        F.hp1 = rescale(F.hp1, qf); F.hp2 = rescale(F.hp2, qf);
        F.skip = 2; rangeNow = changeTo;
        if (muteBlocks < 3) muteBlocks = 3;
      }
      skipNext = 1;
    }
    return out;
    function headroom(r) { var u = REF_MV[r] > bias ? REF_MV[r] - bias : 0; return u < bias ? u : bias; }
  }
  function rescale(v, q) {
    var neg = v < 0, a = neg ? -v : v;
    var r = fl(a / 65536) * q * 4 + fl((a % 65536) * q / 16384);
    return neg ? -r : r;
  }

  /* ---------- stage 2: detection (detectBlock) ---------- */
  function newDet() { return { floor: 0, e: [0, 0, 0, 0, 0], avg: 0, size: 0, hitMax: 0, sinceHit: 60000 }; }
  function hitLevel(v, size) { var s = size ? fl(v * 255 / size) : 255; return s > 255 ? 255 : s < 1 ? 1 : s; }
  function detectHit(d, e, jump, loud, minPct, floorUv, gap, allowed) {
    if (d.floor === 0) d.floor = e + 1;
    if (e < d.floor) d.floor -= fl((d.floor - e) / 4); else d.floor += fl(d.floor / 256) + 1;
    var f = d.floor, x = e > f ? e - f : 0;
    var now = x + d.e[0], before = d.e[1];
    for (var i = 2; i < 5; i++) if (d.e[i] > before) before = d.e[i];
    var avg = fl(d.avg / 16);
    for (i = 4; i > 0; i--) d.e[i] = d.e[i - 1];
    d.e[0] = x;
    d.avg += ((x << 4) - d.avg) >> 7;
    d.size -= fl(d.size / 512);
    if (d.sinceHit < 60000) d.sinceHit++;
    if (d.sinceHit <= FOLLOW_BLOCKS) {
      if (now > d.hitMax) d.hitMax = now;
      if (d.sinceHit === FOLLOW_BLOCKS) {
        if (d.hitMax > d.size) d.size += fl((d.hitMax - d.size) / 4); else d.size -= fl((d.size - d.hitMax) / 8);
      }
      return hitLevel(d.hitMax, d.size);
    }
    if (!allowed || d.sinceHit < gap) return 0;
    if (now < 2 * floorUv + f) return 0;
    if (now * 10 < 2 * before * jump) return 0;
    if (now * 5 < avg * loud) return 0;
    if (now * 100 < d.size * minPct) return 0;
    d.sinceHit = 0; d.hitMax = now;
    if (d.size === 0) d.size = now * 2;
    return hitLevel(now, d.size);
  }

  /* ---------- stage 2: the Pulse look (PULSE START..END) ---------- */
  var BOTTOM = 0, MIDDLE = 1, TOP = 2;
  var SECTION = [0, 0, 1, 1, 2, 2, 0, 0], HUE_OFFSET = [0, 40, 0, 56, 0, 96, 80, 120];
  var MULTI_LEVEL = 220, HUE_MS = 700, FLOW_DELAY_MS = 120, CREST = 255;
  var LOG2_FRAC = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15], SPL_OFFSET_X16 = 256;

  function ease(x) { return fl(x * x * (765 - 2 * x) / 65025); }
  function easeIn(x) { return fl(x * x / 255); }
  function easeOut(x) { return 255 - fl((255 - x) * (255 - x) / 255); }
  function prog(t, len) { return fl(t * 255 / len); }
  function mix(a, b, k) { return [fl((a[0] * (255 - k) + b[0] * k) / 255), fl((a[1] * (255 - k) + b[1] * k) / 255), fl((a[2] * (255 - k) + b[2] * k) / 255)]; }
  function wheel(h) {
    h &= 255;
    if (h < 85) return [255 - h * 3, h * 3, 0];
    if (h < 170) { h -= 85; return [0, 255 - h * 3, h * 3]; }
    h -= 170; return [h * 3, 0, 255 - h * 3];
  }
  function clampLevel(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function barFromBpmX10(b) { return fl(38400000 / b); }
  function addSat(a, b) { return a > 255 - b ? 255 : a + b; }

  function splX16(uv, S) {
    if (uv < 2) return 0;
    var msb = 31 - Math.clz32(uv);
    var norm = (uv * Math.pow(2, 31 - msb)) >>> 0;
    var lg = (msb << 4) + LOG2_FRAC[(norm >>> 27) & 15];
    return ((lg * 1541) >>> 8) + SPL_OFFSET_X16 + S.micTrimDb * 16;
  }

  function stage2(st, S) {
    var n = st.n, leds = new Uint8Array(n * 24);
    var kOn = new Uint8Array(n), sOn = new Uint8Array(n), loud = new Int16Array(n), gains = new Uint8Array(n * 3);
    var phase = new Uint16Array(n), bpm = new Float32Array(n), conf = new Uint8Array(n);
    var kd = newDet(), sd = newDet(), sinceKick2 = 60000;
    var kGap = fl(S.kickGapMs * 100 / BLOCK_MS_X100), sGap = kGap, beatBlocks = fl(2500 * 100 / BLOCK_MS_X100);
    // pulseInit(160): the routine starts its look 160 ms after power-up
    var startMs = 160, lastMs = 160, cyc16 = 0, kickLevel = 0, loudX16 = 0, gainOf = [0, 0, 0];
    var lens = [S.riseMs, S.topPulseMs, S.multiMs, S.pourMs, S.whiteMs, S.drainMs, S.flowMs], pe = [], acc = 0;
    for (var q = 0; q < 7; q++) { acc = (acc + lens[q]) & 0xFFFF; pe.push(acc); }
    var fade = S.kickFadeMs < 11 ? 11 : S.kickFadeMs, KICK_KEEP = 256 - fl((2621 + fl(fade / 2)) / fade);
    var G = { start16: 0, period16: barFromBpmX10(S.bpmX10), min16: barFromBpmX10(S.bpmMax * 10), max16: barFromBpmX10(S.bpmMin * 10),
              lastKick: 0, hk: [0, 0, 0, 0, 0, 0, 0, 0], hs: [0, 0, 0, 0, 0, 0, 0, 0], off: 0, conf: 0, lastEst: 0 };
    var t0 = ((startMs + pe[6]) * 16) >>> 0;
    while (((t0 - startMs * 16) | 0) > 0) t0 = (t0 - G.period16) >>> 0;
    G.start16 = t0;

    function slotScore(r) { return G.hk[r & 7] + G.hk[(r + 5) & 7] + ((G.hs[(r + 2) & 7] + G.hs[(r + 6) & 7]) >> 1); }
    function gridBar() {
      for (var i = 0; i < 8; i++) { G.hk[i] -= G.hk[i] >> 3; G.hs[i] -= G.hs[i] >> 3; }
      var best = 0;
      for (var r = 1; r < 8; r++) if (slotScore(r) > slotScore(best)) best = r;
      var b = slotScore(best), z = slotScore(0);
      if (G.conf >= 4 && best && b >= 96 && b > z + (z >> 1) + 16) {
        G.start16 = (G.start16 + best * (G.period16 >>> 3)) >>> 0;
        G.start16 = (G.start16 - G.period16) >>> 0;
        var k = [], s = [];
        for (var i2 = 0; i2 < 8; i2++) { k.push(G.hk[(i2 + best) & 7]); s.push(G.hs[(i2 + best) & 7]); }
        G.hk = k; G.hs = s;
      }
    }
    function gridAdvance(now) {
      while (((now * 16 - G.start16) | 0) >= G.period16) { G.start16 = (G.start16 + G.period16) >>> 0; gridBar(); }
    }
    function gridSlot(t) {
      var e16 = G.period16 >>> 3, pos = (t * 16 - G.start16) >>> 0;
      var slot = fl((pos + (e16 >>> 1)) / e16) & 255;
      return { slot: slot & 7, err: (pos | 0) - ((slot * e16) | 0) };
    }
    function gridKick(t) {
      var e16 = G.period16 >>> 3, iv = (t - G.lastKick) >>> 0;
      G.lastKick = t;
      if (iv < 100 || iv > 1600) { G.lastEst = 0; return; }
      var iv16 = iv * 16, nn = fl((iv16 + (e16 >>> 1)) / e16) & 255;
      var est = nn ? fl(iv16 * 8 / nn) : 0, prev = G.lastEst;
      var inRange = nn >= 1 && nn <= 8 && est >= G.min16 - (G.min16 >>> 5) && est <= G.max16 + (G.max16 >>> 5);
      G.lastEst = inRange ? est : 0;
      var agree = est - prev; if (agree < 0) agree = -agree;
      if (!inRange || !prev || agree > (est >>> 5)) {
        G.conf = G.conf > 2 ? G.conf - 2 : 0;
        return;
      }
      if (G.conf < 8) G.conf++;
      var p = G.period16 + tr((est - G.period16) / (G.conf < 4 ? 2 : 4));
      if (p < G.min16) p = G.min16;
      if (p > G.max16) p = G.max16;
      G.period16 = p;
      var g = gridSlot(t), ae = g.err < 0 ? -g.err : g.err;
      if (ae <= (G.period16 >>> 5)) {
        G.start16 = (G.start16 + tr(g.err / 4)) >>> 0;
        G.hk[g.slot] = addSat(G.hk[g.slot], 32);
        G.off = 0;
      } else if (++G.off >= 3) {
        G.start16 = (t * 16 - (nn === 5 ? 5 * (G.period16 >>> 3) : 0)) >>> 0;
        for (var i = 0; i < 8; i++) { G.hk[i] >>= 1; G.hs[i] >>= 1; }
        G.off = 0;
      }
    }
    function gridSnare(t) {
      if (G.conf < 4) return;
      var g = gridSlot(t), e = g.err < 0 ? -g.err : g.err;
      if (e <= (G.period16 >>> 5)) G.hs[g.slot] = addSat(G.hs[g.slot], 32);
    }
    function gridPhase(t) {
      var d = (t * 16 - G.start16) | 0;
      while (d < 0) d += G.period16;
      while (d >= G.period16) d -= G.period16;
      return fl(d * 65536 / G.period16);
    }
    function hueAt(tm) { return tm <= 0 ? 0 : fl(tm * 256 / HUE_MS) & 255; }

    function startupLook(i, t, sc, sl) {
      var s = SECTION[i], y = s * 256, c = S.white, lvl = 0;
      if (t < pe[0]) {
        var pos = -154 + fl(666 * ease(prog(t, S.riseMs)) / 255);
        var d = pos - y; if (d < 0) d = -d;
        var a = (s === TOP && pos >= y) ? 255 : clampLevel(255 - fl(d * 255 / 230));
        return [c, fl(S.glowLevel * a / 255)];
      }
      if (t < pe[1]) {
        if (s !== TOP) return [c, 0];
        var u = t - pe[0], nn = S.topPulses ? S.topPulses : 1, per = fl(S.topPulseMs / nn), shape = 0;
        if (per && fl(u / per) < nn) {
          var f = fl((u % per) * 255 / per);
          shape = f < 64 ? ease(f * 4) : 255 - ease(fl((f - 64) * 255 / 191));
        }
        return [c, S.glowLevel + fl((255 - S.glowLevel) * shape / 255)];
      }
      var tm = t - pe[1], th = tm - (2 - s) * FLOW_DELAY_MS;
      var col = wheel(hueAt(th) + HUE_OFFSET[i]);
      if (t < pe[2]) {
        if (s !== TOP) return [c, 0];
        return [tm < 150 ? mix(S.white, col, fl(tm * 255 / 150)) : col, MULTI_LEVEL];
      }
      if (t < pe[3]) {
        var front = 512 - fl(666 * ease(prog(t - pe[2], S.pourMs)) / 255);
        var a2 = s === TOP ? 255 : clampLevel(tr((y + 77 - front) * 255 / 154));
        return [col, fl(MULTI_LEVEL * a2 / 255)];
      }
      if (t < pe[4]) return [mix(col, S.white, ease(prog(t - pe[3], S.whiteMs))), MULTI_LEVEL];
      if (t < pe[5]) {
        var front2 = 666 - fl(820 * easeIn(prog(t - pe[4], S.drainMs)) / 255);
        var a3 = clampLevel(tr((front2 - y + 77) * 255 / 154));
        return [c, fl(MULTI_LEVEL * a3 / 255)];
      }
      var front3 = -154 + fl(896 * easeOut(prog(t - pe[5], S.flowMs)) / 255), dd = front3 - y;
      if (dd < -77) return [S.red, 0];
      if (dd < 0) return [S.red, fl(CREST * (dd + 77) / 77)];
      if (dd < 205) {
        var k = fl(dd * 255 / 205);
        return [mix(S.red, sc[s], k), clampLevel(CREST + tr((sl[s] - CREST) * k / 255))];
      }
      return [sc[s], sl[s]];
    }

    for (var bi = 0; bi < n; bi++) {
      // detectBlock
      var sinceKick = kd.sinceHit;
      var kickHit = detectHit(kd, st.eKick[bi], S.kickJumpX10, S.kickLoudX10, S.kickMinPct, S.kickFloorUv, kGap, st.ok[bi]);
      var kickOnset = kickHit && kd.sinceHit === 0;
      if (sinceKick2 < 60000) sinceKick2++;
      if (kickOnset) sinceKick2 = sinceKick + 1;
      var beat = sinceKick2 < beatBlocks;
      var snareHit = detectHit(sd, st.eSnare[bi], S.snareJumpX10, S.snareLoudX10, S.snareMinPct, S.snareFloorUv, sGap, st.ok[bi] && beat);
      var snareOnset = snareHit && sd.sinceHit === 0;
      kOn[bi] = kickOnset ? 1 : 0; sOn[bi] = snareOnset ? 1 : 0;

      // pulseBlock(now)
      var now = st.now[bi];
      var inst = splX16(st.eAll[bi], S);
      if (inst > loudX16) loudX16 += tr((inst - loudX16) / 32); else loudX16 += tr((inst - loudX16) / 128);
      var th3 = [S.loudBottom, S.loudMiddle, S.loudTop];
      for (var s3 = 0; s3 < 3; s3++) {
        var g3 = tr((loudX16 - (th3[s3] - 3) * 16) * 255 / 48);
        gainOf[s3] = g3 < 0 ? 0 : g3 > 255 ? 255 : g3;
      }
      gridAdvance(now);
      if (kickOnset) gridKick(now);
      if (snareOnset) gridSnare(now);
      if (kickHit) {
        var lv = S.kickMin + fl((255 - S.kickMin) * kickHit / 255);
        if ((lv << 8) > kickLevel) kickLevel = lv << 8;
      }
      var t = (now - startMs) >>> 0, isSteady = t >= pe[6];
      if (isSteady) {
        var inc = fl(((now - lastMs) >>> 0) * 1048576 / ((S.cycleBars ? S.cycleBars : 1) * G.period16));
        cyc16 = (cyc16 + (inc & 0xFFFF)) & 0xFFFF;
      }
      lastMs = now;
      var sc = [], sl = [];
      var tri = cyc16 < 32768 ? cyc16 >> 7 : (65535 - cyc16) >> 7;
      sc[BOTTOM] = mix(S.red, S.orange, ease(tri)); sl[BOTTOM] = S.bottomLevel;
      sc[MIDDLE] = S.red; sl[MIDDLE] = S.middleLevel;
      var ph = gridPhase(now + S.leadMs), env;
      if (ph < 4096) env = fl(ph * 255 / 4096);
      else { var x = fl((ph - 4096) * 255 / 61440); env = fl((255 - x) * (255 - x) / 255); }
      sc[TOP] = S.red; sl[TOP] = (S.topLow + tr((S.topHigh - S.topLow) * env / 255)) & 255;
      if (isSteady) {
        var kk = kickLevel >> 8;
        for (var s4 = 0; s4 < 3; s4++) sl[s4] = (sl[s4] + fl((255 - sl[s4]) * kk * gainOf[s4] / 65025)) & 255;
      }
      kickLevel = (fl(kickLevel * KICK_KEEP / 256)) & 0xFFFF;
      for (var L = 0; L < 8; L++) {
        var look = isSteady ? [sc[SECTION[L]], sl[SECTION[L]]] : startupLook(L, t, sc, sl);
        var c = look[0], level = look[1];
        var k2 = fl(level * level / 255); k2 = fl(k2 * S.brightness / 255);
        var o = bi * 24 + L * 3;
        leds[o] = fl(c[0] * k2 / 255); leds[o + 1] = fl(c[1] * k2 / 255); leds[o + 2] = fl(c[2] * k2 / 255);
      }
      loud[bi] = loudX16; gains[bi * 3] = gainOf[0]; gains[bi * 3 + 1] = gainOf[1]; gains[bi * 3 + 2] = gainOf[2];
      phase[bi] = gridPhase(now); bpm[bi] = 38400000 / G.period16 / 10; conf[bi] = G.conf;
    }
    return { leds: leds, kOn: kOn, sOn: sOn, loud: loud, gains: gains, phase: phase, bpm: bpm, conf: conf, phaseEnds: pe, startMs: startMs };
  }

  /* ---------- a drum & bass demo: 174 BPM, kicks on 1 and the "and" of 3, snares on 2 and 4 ---------- */
  function synthDnb(rate, opts) {
    opts = opts || {};
    var bpm = opts.bpm || 174, eighth = 60 / bpm / 2, bars = opts.bars || 26, start = 0.3;
    var breakFrom = opts.breakFrom == null ? 12 : opts.breakFrom, breakTo = opts.breakTo == null ? 16 : opts.breakTo;
    var total = start + bars * 8 * eighth + 1.0, N = fl(total * rate), out = new Float32Array(N);
    var seed = opts.seed || 21;
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; }
    function make(len, fn) { var a = new Float32Array(fl(len * rate)); fn(a); return a; }
    var kick = make(0.35, function (a) { var ph = 0; for (var i = 0; i < a.length; i++) { var t = i / rate, f = 50 + 140 * Math.exp(-t / 0.02); ph += 2 * Math.PI * f / rate; a[i] = Math.sin(ph) * Math.exp(-t / 0.12) * Math.min(1, t / 0.0008) + rnd() * Math.exp(-t / 0.002) * 0.3; } });
    var snare = make(0.3, function (a) { var lp = 0, prev = 0, ph = 0; for (var i = 0; i < a.length; i++) { var t = i / rate, w = rnd(), hp = w - prev; prev = w; lp += (hp - lp) * 0.5; ph += 2 * Math.PI * 190 / rate; a[i] = (lp * 1.4 * Math.exp(-t / 0.06) + 0.6 * Math.sin(ph) * Math.exp(-t / 0.05)) * Math.min(1, t / 0.0006); } });
    var hat = make(0.06, function (a) { var prev = 0; for (var i = 0; i < a.length; i++) { var w = rnd(); a[i] = (w - prev) * 0.5 * Math.exp(-(i / rate) / 0.012); prev = w; } });
    function place(s, t, g) { var i0 = fl(t * rate); for (var i = 0; i < s.length && i0 + i < N; i++) out[i0 + i] += g * s[i]; }
    for (var bar = 0; bar < bars; bar++) {
      var drums = bar >= 1 && !(bar >= breakFrom && bar < breakTo);
      for (var e = 0; e < 8; e++) {
        var t = start + (bar * 8 + e) * eighth;
        var kickHere = opts.house ? e % 2 === 0 : (e === 0 || e === 5), snareHere = e === 2 || e === 6;
        if (drums && kickHere) place(kick, t, 1.0);
        if (drums && snareHere) place(snare, t, 0.75);
        if (bar >= 1) { place(hat, t, 0.10); place(hat, t + eighth / 2, 0.06); }
      }
    }
    // a growling reese bass and a pad: plays through the breakdown too
    var notes = [36.71, 36.71, 41.2, 32.7];
    for (var j = 0; j < N; j++) {
      var tj = j / rate, b = fl((tj - start) / (8 * eighth));
      if (b < 1 || b >= bars) continue;
      var f0 = notes[b % 4], bass = 0;
      for (var d = -1; d <= 1; d += 2) bass += 2 * ((tj * f0 * (1 + d * 0.006)) % 1) - 1;
      var pad = 0.05 * (Math.sin(2 * Math.PI * 220 * tj) + Math.sin(2 * Math.PI * 261.6 * tj) + Math.sin(2 * Math.PI * 329.6 * tj));
      out[j] += 0.16 * bass + pad;
    }
    var l1 = 0, l2 = 0, al = 1 - Math.exp(-2 * Math.PI * 4000 / rate);
    for (j = 0; j < N; j++) { l1 += (out[j] - l1) * al; l2 += (l1 - l2) * al; out[j] = l2; }
    var pk = 0; for (j = 0; j < N; j++) pk = Math.max(pk, Math.abs(out[j]));
    for (j = 0; j < N; j++) out[j] *= 0.85 / pk;
    return { audio: out, start: start, eighth: eighth, bars: bars, breakFrom: breakFrom, breakTo: breakTo };
  }

  return { DEFAULTS: DEFAULTS, ROOMS: ROOMS, micVolts: micVolts, stage1: stage1, stage2: stage2, synthDnb: synthDnb, BLOCK_MS: 12.8 };
})();

export const { DEFAULTS, ROOMS, micVolts, stage1, stage2, synthDnb, BLOCK_MS } = PulseEngine;
export default PulseEngine;
