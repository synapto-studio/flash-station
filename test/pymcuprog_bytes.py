"""
Byte-for-byte check: the browser flasher (js/updi.js) must send the same sequences as
pymcuprog for entering programming mode, writing a flash page, writing a fuse, writing
the user row and leaving programming mode.

Run: python3 test/pymcuprog_bytes.py
"""
import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pymcuprog_vs_sim as harness  # noqa: E402  (patches serial.Serial)

FAILED = False


def check(name, ok):
    global FAILED
    print(('PASS ' if ok else 'FAIL ') + name)
    FAILED |= not ok


def pymcuprog_log(device, argv):
    harness.BRIDGE = harness.Bridge(device)
    harness.BRIDGE.cmd('CLEARLOG')
    code = harness.run(argv + ['-t', 'uart', '-u', '/dev/fake', '-d', device])
    log = harness.BRIDGE.cmd('LOG')[4:]
    harness.BRIDGE.close()
    return code, log


def main():
    random.seed(7)
    tmp = tempfile.mkdtemp()
    for device in ('attiny412', 'attiny1614'):
        page = bytes(random.randrange(256) for _ in range(64))
        row = bytes(random.randrange(256) for _ in range(32))
        js = json.loads(subprocess.check_output(
            ['node', os.path.join(HERE, 'js-ops.mjs'), device, page.hex(), row.hex()], text=True))

        path = os.path.join(tmp, 'page.hex')
        harness.write_hex(path, {a: b for a, b in enumerate(page)})
        code, log = pymcuprog_log(device, ['write', '-f', path, '--erase'])
        check(device + ': pymcuprog wrote the page', code == 0)
        check(device + ': enter programming mode bytes match', js['enterProg'] in log)
        check(device + ': flash page write bytes match', js['pageWrite'] in log)
        check(device + ': leave programming mode bytes match', log.endswith(js['leaveProg']))

        code, log = pymcuprog_log(device, ['write', '-m', 'user_row', '-l'] + ['0x%02x' % b for b in row])
        check(device + ': user row write bytes match', code == 0 and js['userRowWrite'] in log)

        if 'fuseWrite' in js:
            code, log = pymcuprog_log(device, ['write', '-m', 'fuses', '-o', '8', '-l', '0x0c'])
            check(device + ': fuse write bytes match', code == 0 and js['fuseWrite'] in log)

    print('ALL PASS' if not FAILED else 'SOME FAILED')
    sys.exit(1 if FAILED else 0)


if __name__ == '__main__':
    main()
