#!/usr/bin/env python3
"""
Reference: the parts of the Pi tool (station/pulse_station.py v1.0, from the
"Pulse 1.0 Source" doc) that build a pulsetest image, copied unchanged, so the JS port
in js/engines.js can be checked byte for byte.

  python3 test/ref_pulse_station.py image <linked_app.hex> <boot.hex> <out_full.hex> [name=value ...]
  python3 test/ref_pulse_station.py plan test <r> <g> <b>
  python3 test/ref_pulse_station.py plan patch|full <linked_app.hex> [name=value ...]

The frame and plan functions at the bottom ("Frames and plans") are written straight from
docs/STATION-PROTOCOL.md, independently of js/station.js, so the two can be compared.
`plan` prints the steps as JSON: [[baud, stopbits, hex, gapMs], ...].
"""
import struct
import sys

APP_START = 0x0C00
PAGE = 64
APP_PAGES = 208
TRAILER_PAGE = 207
APP_MAX = TRAILER_PAGE * PAGE
BOOTEND = APP_START // 256
FUSE_HEX_ADDR = 0x820000
VERSION = (1, 0)
TAG = b'SOTA.PLS'
FIELDS = [
    ('tag', '8s', ''), ('layout', 'B', ''),
    ('brightness', 'B', ''),
    ('white', '3B', ''), ('red', '3B', ''), ('orange', '3B', ''),
    ('riseMs', 'H', ''), ('topPulseMs', 'H', ''), ('multiMs', 'H', ''), ('pourMs', 'H', ''),
    ('whiteMs', 'H', ''), ('drainMs', 'H', ''), ('flowMs', 'H', ''),
    ('topPulses', 'B', ''), ('glowLevel', 'B', ''),
    ('bottomLevel', 'B', ''), ('middleLevel', 'B', ''), ('topHigh', 'B', ''), ('topLow', 'B', ''),
    ('cycleBars', 'B', ''), ('bpmX10', 'H', ''), ('bpmMin', 'B', ''), ('bpmMax', 'B', ''),
    ('leadMs', 'B', ''), ('micTrimDb', 'b', ''), ('loudTop', 'B', ''), ('loudMiddle', 'B', ''),
    ('loudBottom', 'B', ''), ('kickFadeMs', 'H', ''), ('kickMin', 'B', ''),
    ('kickJumpX10', 'B', ''), ('kickLoudX10', 'B', ''), ('kickMinPct', 'B', ''),
    ('kickFloorUv', 'H', ''), ('kickGapMs', 'H', ''),
    ('snareJumpX10', 'B', ''), ('snareLoudX10', 'B', ''), ('snareMinPct', 'B', ''),
    ('snareFloorUv', 'H', ''),
]
FMT = '<' + ''.join(f for _, f, _ in FIELDS)
assert struct.calcsize(FMT) == 64


def unpack_settings(block):
    vals = list(struct.unpack(FMT, block))
    out = {}
    for name, f, _ in FIELDS:
        n = 3 if f == '3B' else 1
        v = vals[:n]
        del vals[:n]
        out[name] = list(v) if n == 3 else v[0]
    out['tag'] = out['tag'].decode('ascii', 'replace')
    return out


def pack_settings(d):
    vals = []
    for name, f, _ in FIELDS:
        v = d[name]
        if name == 'tag':
            v = v.encode('ascii') if isinstance(v, str) else v
        vals.extend(v if f == '3B' else [v])
    return struct.pack(FMT, *vals)


def crc16(data, c=0xFFFF):
    for b in data:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    return c


def read_hex(path):
    mem, base = {}, 0
    for line in open(path):
        line = line.strip()
        if not line.startswith(':'):
            continue
        n, a, t = int(line[1:3], 16), int(line[3:7], 16), int(line[7:9], 16)
        d = bytes.fromhex(line[9:9 + 2 * n])
        if t == 0:
            for i, b in enumerate(d):
                mem[base + a + i] = b
        elif t == 2:
            base = int(line[9:13], 16) << 4
        elif t == 4:
            base = int(line[9:13], 16) << 16
    return mem


def write_hex(path, mem):
    lines, upper = [], None
    addrs = sorted(mem)
    i = 0
    while i < len(addrs):
        a = addrs[i]
        if a >> 16 != upper:
            upper = a >> 16
            rec = bytes([2, 0, 0, 4, upper >> 8, upper & 255])
            lines.append(':' + rec.hex().upper() + '%02X' % (-sum(rec) & 255))
        chunk = [mem[a]]
        while (len(chunk) < 16 and i + len(chunk) < len(addrs) and addrs[i + len(chunk)] == a + len(chunk)
               and (a + len(chunk)) >> 16 == upper):
            chunk.append(mem[a + len(chunk)])
        rec = bytes([len(chunk), (a >> 8) & 255, a & 255, 0]) + bytes(chunk)
        lines.append(':' + rec.hex().upper() + '%02X' % (-sum(rec) & 255))
        i += len(chunk)
    lines.append(':00000001FF')
    with open(path, 'w') as f:
        f.write('\n'.join(lines) + '\n')


class Image:
    def __init__(self, app, settings=None):
        self.app = bytearray(app)
        i = self.app.find(TAG)
        if i < 0 or i % PAGE:
            sys.exit('No page-aligned SOTA.PLS settings block in this routine.')
        self.set_page = i // PAGE
        if settings is not None:
            self.app[i:i + 64] = pack_settings(settings)
        if len(self.app) > APP_MAX:
            sys.exit('Routine is %d bytes: too big (max %d).' % (len(self.app), APP_MAX))
        self.trailer = self.make_trailer()

    @classmethod
    def from_hex(cls, path, settings=None):
        mem = read_hex(path)
        app_bytes = [a for a in mem if APP_START <= a < APP_START + APP_MAX]
        end = max(app_bytes) + 1
        app = bytes(mem.get(a, 0xFF) for a in range(APP_START, end))
        return cls(app, settings)

    @property
    def settings(self):
        i = self.set_page * PAGE
        return unpack_settings(bytes(self.app[i:i + 64]))

    def code_crc(self):
        i = self.set_page * PAGE
        return crc16(bytes(self.app[:i]) + bytes(self.app[i + PAGE:]))

    def make_trailer(self):
        t = bytearray(b'\xff' * PAGE)
        t[0:4] = b'SPL1'
        struct.pack_into('<HHHBBB', t, 4, len(self.app), crc16(self.app), self.code_crc(),
                         self.set_page, VERSION[0], VERSION[1])
        struct.pack_into('<H', t, 62, crc16(bytes(t[:62])))
        return bytes(t)

    def pages(self):
        out = []
        for p in range((len(self.app) + PAGE - 1) // PAGE):
            d = bytes(self.app[p * PAGE:(p + 1) * PAGE])
            out.append((p, d + b'\xff' * (PAGE - len(d))))
        out.append((TRAILER_PAGE, self.trailer))
        return out

    def image_id(self):
        return crc16(bytes(self.app) + self.trailer)

    def memory(self):
        mem = {}
        for p, d in self.pages():
            for j, b in enumerate(d):
                if p == TRAILER_PAGE or p * PAGE + j < len(self.app):
                    mem[APP_START + p * PAGE + j] = b
        return mem


# ---------------------------------------------------------------- Frames and plans
BAUD = 1000
TEST_REPEATS = 110  # 0.1 s gaps + 80 ms per frame: about 20 s


def frame(ftype, payload):
    body = bytes([ftype, len(payload)]) + bytes(payload)
    return b'\x5a\xa5' + body + struct.pack('<H', crc16(body))


def wake(ms):
    return b'\xf0' * (ms // 10)  # 0xF0 at 1000 baud = 10 ms per byte


def header_frame(img, patch, pages):
    mask = bytearray(26)
    for p in pages:
        mask[p // 8] |= 1 << (p % 8)
    payload = struct.pack('<HBHHHB', img.image_id(), 1 if patch else 0, len(img.app), crc16(img.app),
                          img.code_crc(), img.set_page) + bytes(mask)
    assert len(payload) == 36
    return frame(ord('H'), payload)


def page_frame(img, patch, index, data):
    payload = struct.pack('<HBB', img.image_id(), 1 if patch else 0, index) + bytes(data)
    assert len(payload) == 68
    return frame(ord('P'), payload)


def test_plan(r, g, b):
    steps = [(BAUD, 1, wake(3000), 0)]
    steps += [(BAUD, 1, frame(ord('T'), bytes([r, g, b])), 100)] * TEST_REPEATS
    return steps


def patch_plan(img):
    pages = dict(img.pages())
    steps = [(BAUD, 1, wake(5000), 0)]
    for copy in range(4):
        if copy:
            steps.append((BAUD, 1, wake(400), 0))
        steps.append((BAUD, 1, header_frame(img, True, [img.set_page, TRAILER_PAGE]), 150))
        steps.append((BAUD, 1, page_frame(img, True, img.set_page, pages[img.set_page]), 30))
        steps.append((BAUD, 1, page_frame(img, True, TRAILER_PAGE, pages[TRAILER_PAGE]), 30))
    return steps


def full_plan(img):
    pages = img.pages()
    all_pages = [p for p, _ in pages]
    steps = [(BAUD, 1, wake(5000), 0)]
    first = True
    for _ in range(2):
        for n, (p, d) in enumerate(pages):
            if n % 8 == 0:
                if not first:
                    steps.append((BAUD, 1, wake(400), 0))
                steps.append((BAUD, 1, header_frame(img, False, all_pages), 150))
            first = False
            steps.append((BAUD, 1, page_frame(img, False, p, d), 30))
    return steps


def plan_json(steps):
    import json
    return json.dumps([[b, s, d.hex().upper(), g] for b, s, d, g in steps])


def plan_main(args):
    kind = args[0]
    if kind == 'test':
        print(plan_json(test_plan(*[int(x) for x in args[1:4]])))
        return
    base = Image.from_hex(args[1])
    s = base.settings
    for kv in args[2:]:
        k, v = kv.split('=', 1)
        s[k] = [int(x) for x in v.split(',')] if ',' in v else int(v)
    img = Image(base.app, s)
    print(plan_json(patch_plan(img) if kind == 'patch' else full_plan(img)))


def main():
    if sys.argv[1] == 'plan':
        return plan_main(sys.argv[2:])
    _, cmd, app_hex, boot_hex, out = sys.argv[:5]
    sets = sys.argv[5:]
    base = Image.from_hex(app_hex)
    s = base.settings
    for kv in sets:
        k, v = kv.split('=', 1)
        s[k] = [int(x) for x in v.split(',')] if ',' in v else int(v)
    img = Image(base.app, s)
    full = img.memory()
    full.update(read_hex(boot_hex))
    full[FUSE_HEX_ADDR + 8] = BOOTEND
    write_hex(out, full)
    print('%04X' % img.image_id())


if __name__ == '__main__':
    main()
