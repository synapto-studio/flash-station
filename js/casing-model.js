// Reads a casing model file (.casing, made by the firmware repo's casing/tools/stl_to_web.py from
// Fusion 360 STL exports): a small header saying what each part is and how it looks, then each
// part's corners and triangles, packed small.
//
//   "SYN3", header length (4 bytes, little-endian), header (JSON), then per part:
//   positions (uint16 x3, spread over the part's min..max), normals (int8 x3), triangles (uint16 or uint32 x3)
//
// The model's frame is the drive's own, in mm: z runs from the plug end up to the logo, x across the
// drive, y through it. plugTopZ is where the drive profile's heights start (the profile's y is mm
// above the top of the USB A connector), frontY says which side the profile's front LEDs face.
//
// Twin: the firmware repo's casing/web/casing-model.js (its preview page). Change both.

export const LOOKS = ['shell', 'resin', 'board', 'metal', 'plastic', 'gold'];

export function readCasing(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'SYN3') {
    throw new Error('That isn\'t a casing model file. Make one with casing/tools/stl_to_web.py.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  if (header.type !== 'casing-model' || header.format !== 1) throw new Error('This casing model is a newer format than this app reads.');
  const base = 8 + n;
  const copy = (T, at, count) => {          // a fresh, aligned copy of one part's numbers
    const start = bytes.byteOffset + base + at;
    return new T(bytes.buffer.slice(start, start + count * T.BYTES_PER_ELEMENT));
  };
  const parts = header.parts.map((p) => ({
    ...p,
    position: copy(Uint16Array, p.offsets.position, p.vertices * 3),
    normal: copy(Int8Array, p.offsets.normal, p.vertices * 3),
    index: copy(p.indexBytes === 2 ? Uint16Array : Uint32Array, p.offsets.index, p.triangles * 3),
  }));
  return { ...header, parts };
}

// The model's overall size: { min: [x, y, z], max: [x, y, z] } in mm.
export function bounds(model, { standIns = true } = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of model.parts) {
    if (p.standIn && !standIns) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.min[k]); hi[k] = Math.max(hi[k], p.max[k]); }
  }
  return { min: lo, max: hi };
}
