#!/usr/bin/env python3
"""
Reference: the parts of the Pi tool (station/pulse_station.py v1.0, from the
"Pulse 1.0 Source" doc) that build a pulsetest image, copied unchanged, so the JS port
in js/engines.js can be checked byte for byte.

  python3 test/ref_pulse_station.py image <linked_app.hex> <boot.hex> <out_full.hex> [name=value ...]
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


def main():
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
