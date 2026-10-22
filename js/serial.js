// Web Serial transport: the browser's way to talk to a USB serial device (the UPDI Friend,
// and later the XIAO station). Chrome and Edge only, on an https page or localhost.

export function webSerialSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

// Which of our boxes a USB serial port is, from its USB vendor ID (the maker's number).
const FRIEND_VIDS = [0x1a86]; // CH340: the Adafruit UPDI Friend
const STATION_VIDS = [0x2e8a, 0x2886]; // Raspberry Pi RP2040, Seeed: the XIAO station box

export function portKind(info) {
  const vid = (info && info.usbVendorId) || 0;
  if (FRIEND_VIDS.includes(vid)) return 'friend';
  if (STATION_VIDS.includes(vid)) return 'station';
  return null;
}

const kindOf = (port) => portKind(port.getInfo ? port.getInfo() : {});

// Ports Chrome already lets this page use (chosen once, on any earlier visit) that are
// plugged in now. Opening one needs no click, so the page can connect by itself.
export async function grantedPorts(kind) {
  if (!webSerialSupported()) return [];
  return (await navigator.serial.getPorts()).filter((p) => kindOf(p) === kind);
}

// Calls fn(port) whenever a port Chrome already lets this page use is plugged in.
export function onPlugged(kind, fn) {
  if (!webSerialSupported()) return;
  navigator.serial.addEventListener('connect', (ev) => {
    if (kindOf(ev.target) === kind) fn(ev.target);
  });
}

export class WebSerialTransport {
  constructor(port) {
    this.port = port;
    this.buf = [];
    this.waiters = [];
    this.reader = null;
    this.reading = null;
    this.closing = false;
    this.isOpen = false;
  }

  // Shows Chrome's port picker. Must be called from a click.
  static async request() {
    const port = await navigator.serial.requestPort();
    return new WebSerialTransport(port);
  }

  describe() {
    const i = this.port.getInfo ? this.port.getInfo() : {};
    if (!i.usbVendorId) return 'USB serial device';
    const vid = i.usbVendorId.toString(16).padStart(4, '0');
    const pid = (i.usbProductId || 0).toString(16).padStart(4, '0');
    const known = { '1a86': 'CH340 (UPDI Friend)', '2e8a': 'RP2040 (XIAO)', '2886': 'Seeed XIAO' };
    return `${known[vid] || 'USB serial'} · ${vid}:${pid}`;
  }

  async open(o) {
    await this.port.open({
      baudRate: o.baudRate,
      dataBits: o.dataBits || 8,
      parity: o.parity || 'none',
      stopBits: o.stopBits || 1,
      bufferSize: 8192,
    });
    this.isOpen = true;
    this.buf = [];
    this.closing = false;
    this.reading = this.readLoop();
  }

  async readLoop() {
    // A framing, parity or break error ends one readable stream; Chrome then offers a
    // fresh one, so keep going until the port is closed.
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            for (const b of value) this.buf.push(b);
            this.wake();
          }
        }
      } catch (e) {
        this.lastError = e;
      } finally {
        try {
          this.reader.releaseLock();
        } catch {}
        this.reader = null;
      }
    }
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async read(n, timeoutMs = 1000) {
    const end = performance.now() + timeoutMs;
    while (this.buf.length < n) {
      const left = end - performance.now();
      if (left <= 0) break;
      await new Promise((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
    return Uint8Array.from(this.buf.splice(0, n));
  }

  // Drops anything received but not read yet (a late reply to a command that timed out).
  discard() {
    this.buf = [];
  }

  // The device went away while open (unplugged, or the station restarting after new firmware).
  get lost() {
    return this.isOpen && (!this.port.readable || !this.port.writable);
  }

  async write(bytes) {
    if (!this.port.writable) throw new Error("The USB connection was lost.");
    const w = this.port.writable.getWriter();
    try {
      await w.write(Uint8Array.from(bytes));
    } finally {
      w.releaseLock();
    }
  }

  async close() {
    if (!this.isOpen) return;
    this.closing = true;
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
    }
    try {
      await this.reading;
    } catch {}
    try {
      await this.port.close();
    } catch {}
    this.isOpen = false;
    this.closing = false;
  }
}
