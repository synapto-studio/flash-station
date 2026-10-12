// Prints the exact bytes the browser flasher sends for a few operations, as JSON, so
// test/pymcuprog_bytes.py can check pymcuprog sends the same sequences.
import { SimChip, SimTransport } from '../js/sim.js';
import { UpdiProgrammer } from '../js/updi.js';

const [device, pageHex, rowHex] = process.argv.slice(2);
const chip = new SimChip(device);
const t = new SimTransport(chip);
const p = new UpdiProgrammer(t);
const hex = (a) => Buffer.from(a).toString('hex');
const out = {};

await p.connect();
t.log = [];
await p.enterProgMode();
out.enterProg = hex(t.log);
await p.identify();

t.log = [];
await p.writeFlashPage(0x8000, Array.from(Buffer.from(pageHex, 'hex')));
out.pageWrite = hex(t.log);

if (device === 'attiny1614') {
  t.log = [];
  await p.writeFuse(8, 0x0c);
  out.fuseWrite = hex(t.log);
}

t.log = [];
await p.writeUserRow(Buffer.from(rowHex, 'hex'));
out.userRowWrite = hex(t.log);

t.log = [];
await p.leaveProgMode();
out.leaveProg = hex(t.log);
console.log(JSON.stringify(out));
