// Runs a simulated chip behind a line protocol on stdin/stdout, so the real pymcuprog
// (through test/pymcuprog_vs_sim.py) can program it. One command per line:
//   OPEN <baud>   CLOSE   WRITE <hex>   READ <n>   DUMP
// Started as: node test/sim-server.mjs <device> [nochip]

import readline from 'node:readline';
import { SimChip, SimTransport } from '../js/sim.js';

const device = process.argv[2] || 'attiny1614';
const chip = process.argv[3] === 'nochip' ? null : new SimChip(device);
const t = new SimTransport(chip);
const hex = (a) => Buffer.from(a).toString('hex');

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, arg] = line.trim().split(' ');
  if (cmd === 'OPEN') {
    if (t.isOpen) await t.close();
    await t.open({ baudRate: Number(arg) });
    console.log('OK');
  } else if (cmd === 'CLOSE') {
    await t.close();
    console.log('OK');
  } else if (cmd === 'WRITE') {
    await t.write(Buffer.from(arg || '', 'hex'));
    console.log('OK');
  } else if (cmd === 'READ') {
    console.log('DATA ' + hex(await t.read(Number(arg))));
  } else if (cmd === 'LOG') {
    console.log('LOG ' + hex(t.log));
  } else if (cmd === 'CLEARLOG') {
    t.log = [];
    console.log('OK');
  } else if (cmd === 'DUMP') {
    console.log(
      'DUMP ' +
        JSON.stringify(chip && {
          flash: hex(chip.flash),
          fuses: chip.fuses,
          userRow: hex(chip.userRow),
          stats: chip.stats,
        }),
    );
  }
}
