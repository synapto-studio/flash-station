// Runs the slow parts of song moments (js/moments.js) away from the screen, so dragging the marks
// never stutters: learning a moment takes a second or two. Started by js/moments-tab.js.

import { beatGrid, findDrop, learnMoment, checkOther } from './moments.js';

const clips = new Map();   // the song clips this page has sent, by name: mono at moments.RATE
self.onmessage = (e) => {
  const { id, op, clip, rate } = e.data;
  try {
    let out;
    if (op === 'clip') { clips.set(clip, e.data.audio); out = true; }
    else if (op === 'grid') { const g = beatGrid(clips.get(clip), rate); out = { grid: g, drop: findDrop(clips.get(clip), rate, g) }; }
    else if (op === 'learn') out = learnMoment(clips.get(clip), rate, e.data.marks);
    else if (op === 'check') out = checkOther(e.data.moment, e.data.audio, rate);
    else throw new Error(`unknown job ${op}`);
    self.postMessage({ id, out });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
