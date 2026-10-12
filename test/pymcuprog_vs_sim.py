"""
Cross-check: drive the simulated chip (js/sim.js) with the real pymcuprog, the tool the
firmware guides use on real boards. If pymcuprog can ping, erase, write, verify and
write fuses and the user row on the simulator, the simulator behaves like a real chip,
so the browser flasher's tests against it mean something.

Run: python3 -I test/pymcuprog_vs_sim.py
"""
import json
import os
import random
import subprocess
import sys
import tempfile

import serial  # pyserial

HERE = os.path.dirname(os.path.abspath(__file__))


class Bridge:
    def __init__(self, device, nochip=False):
        args = ['node', os.path.join(HERE, 'sim-server.mjs'), device] + (['nochip'] if nochip else [])
        self.p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def cmd(self, line):
        self.p.stdin.write(line + '\n')
        self.p.stdin.flush()
        return self.p.stdout.readline().strip()

    def dump(self):
        return json.loads(self.cmd('DUMP')[5:])

    def close(self):
        self.p.stdin.close()
        self.p.wait()


BRIDGE = None


class FakeSerial:
    """Stands in for serial.Serial inside pymcuprog's serialupdi/physical.py."""

    def __init__(self, port, baudrate=9600, **kw):
        self.timeout = kw.get('timeout')
        BRIDGE.cmd('OPEN %d' % baudrate)

    def write(self, data):
        BRIDGE.cmd('WRITE ' + bytes(data).hex())
        return len(data)

    def read(self, size=1):
        return bytes.fromhex(BRIDGE.cmd('READ %d' % size)[5:])

    def readline(self):
        return self.read(64)

    def close(self):
        BRIDGE.cmd('CLOSE')

    def flush(self):
        pass


serial.Serial = FakeSerial
from pymcuprog import pymcuprog as pymcuprog_cli  # noqa: E402  (after the patch)


def run(argv):
    sys.argv = ['pymcuprog'] + argv
    try:
        return pymcuprog_cli.main()
    except SystemExit as e:
        return e.code


def write_hex(path, mem):
    from intelhex import IntelHex
    ih = IntelHex()
    for a, b in mem.items():
        ih[a] = b
    ih.write_hex_file(path)


def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        global FAILED
        FAILED = True


FAILED = False


def main():
    global BRIDGE
    random.seed(1)
    tmp = tempfile.mkdtemp()
    for device, size in (('attiny412', 0x1000), ('attiny1614', 0x4000)):
        BRIDGE = Bridge(device)
        base = ['-t', 'uart', '-u', '/dev/fake', '-d', device]

        check(device + ': ping', run(['ping'] + base) == 0)

        # A firmware image with a gap, plus BOOTEND for the Pulse.
        mem = {a: random.randrange(256) for a in range(0, 3000)}
        mem.update({a: random.randrange(256) for a in range(size - 64, size)})
        if device == 'attiny1614':
            mem[0x820008] = 0x0C
        path = os.path.join(tmp, device + '.hex')
        write_hex(path, mem)
        check(device + ': write --erase --verify', run(['write'] + base + ['-f', path, '--erase', '--verify']) == 0)

        d = BRIDGE.dump()
        flash = bytes.fromhex(d['flash'])
        check(device + ': flash contents', all(flash[a] == v for a, v in mem.items() if a < 0x800000))
        check(device + ': blank where nothing was written', flash[3000:size - 64] == b'\xff' * (size - 64 - 3000))
        if device == 'attiny1614':
            check(device + ': BOOTEND fuse', d['fuses'][8] == 0x0C)

        # User row (what the IS's ID card uses)
        row = [random.randrange(256) for _ in range(32)]
        check(device + ': write user row', run(['write'] + base + ['-m', 'user_row', '-l'] + ['0x%02x' % b for b in row]) == 0)
        check(device + ': user row contents', bytes.fromhex(BRIDGE.dump()['userRow']) == bytes(row))

        # Chip erase leaves the user row alone
        check(device + ': erase', run(['erase'] + base) == 0)
        d = BRIDGE.dump()
        check(device + ': erase blanks flash', bytes.fromhex(d['flash']) == b'\xff' * size)
        check(device + ': erase keeps user row', bytes.fromhex(d['userRow']) == bytes(row))
        BRIDGE.close()

    # Nothing on the pin: pymcuprog must fail, not hang or pretend
    BRIDGE = Bridge('attiny1614', nochip=True)
    check('no chip: ping fails', run(['ping', '-t', 'uart', '-u', '/dev/fake', '-d', 'attiny1614']) != 0)
    BRIDGE.close()

    # Wrong chip: pymcuprog refuses
    BRIDGE = Bridge('attiny412')
    check('wrong chip: ping fails', run(['ping', '-t', 'uart', '-u', '/dev/fake', '-d', 'attiny1614']) != 0)
    BRIDGE.close()

    print('ALL PASS' if not FAILED else 'SOME FAILED')
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
