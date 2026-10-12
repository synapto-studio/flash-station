import test from 'node:test';
import assert from 'node:assert/strict';
import { SimChip, SimTransport } from '../js/sim.js';
import { UpdiProgrammer } from '../js/updi.js';

function rand(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 16) & 0xff;
}

async function session(device) {
  const chip = new SimChip(device);
  const t = new SimTransport(chip);
  const p = new UpdiProgrammer(t);
  await p.connect();
  const info = await p.identify();
  return { chip, t, p, info };
}

for (const [device, idHex] of [['attiny412', '1E9223'], ['attiny1614', '1E9422'], ['attiny3216', '1E9521']]) {
  test(`${device}: identify`, async () => {
    const { chip, info, p } = await session(device);
    assert.equal(info.idHex, idHex);
    assert.equal(info.device.id, chip.dev.id);
    assert.equal(info.serial, Buffer.from(chip.serial).toString('hex').toUpperCase());
    assert.deepEqual(info.fuses, chip.fuses);
    assert.equal(info.userRow.length, 32);
    await p.disconnect();
    assert.equal(chip.nvmProg, false, 'left programming mode');
  });

  test(`${device}: erase, write, read back`, async () => {
    const { chip, p } = await session(device);
    const r = rand(42);
    const img = new Uint8Array(chip.dev.flashSize - 512).map(() => r());
    img.fill(0xff, 1000, 2000); // a blank stretch that gets skipped
    chip.flash.fill(0x00); // old contents
    await p.chipErase();
    const written = await p.writeFlash(0, img);
    assert.ok(written < Math.ceil(img.length / chip.dev.flashPage), 'blank pages skipped');
    assert.deepEqual(chip.flash.subarray(0, img.length), img);
    assert.ok(chip.flash.subarray(img.length).every((b) => b === 0xff));
    const back = await p.readFlash(0, img.length);
    assert.deepEqual(back, img);
    await p.disconnect();
  });
}

test('fuses: BOOTEND written, SYSCFG0 refused', async () => {
  const { chip, p } = await session('attiny1614');
  await p.writeFuse(8, 0x0c);
  assert.equal(chip.fuses[8], 0x0c);
  assert.deepEqual(await p.readFuses(), chip.fuses);
  await assert.rejects(p.writeFuse(5, 0x00), /Refusing/);
  assert.equal(chip.fuses[5], 0xf6);
  await p.disconnect();
});

test('user row: written, read back, survives chip erase', async () => {
  const { chip, p } = await session('attiny412');
  const row = Uint8Array.from({ length: 32 }, (_, i) => i * 3);
  await p.writeUserRow(row);
  assert.deepEqual(chip.userRow, row);
  await p.chipErase();
  assert.deepEqual(await p.readUserRow(), row);
  await p.disconnect();
});

test('no chip on the pin: a clear error', async () => {
  const p = new UpdiProgrammer(new SimTransport(null));
  await assert.rejects(p.connect(), (e) => e.code === 'no-chip');
});

test('no echo (wrong port): a clear error', async () => {
  const silent = {
    open: async () => {},
    close: async () => {},
    write: async () => {},
    read: async () => new Uint8Array(0),
  };
  const p = new UpdiProgrammer(silent);
  await assert.rejects(p.connect(), (e) => e.code === 'no-echo');
});

test('reconnect after a session works (UPDI was switched off)', async () => {
  const chip = new SimChip('attiny1614');
  const t = new SimTransport(chip);
  let p = new UpdiProgrammer(t);
  await p.connect();
  await p.identify();
  await p.disconnect();
  p = new UpdiProgrammer(t);
  await p.connect();
  const info = await p.identify();
  assert.equal(info.idHex, '1E9422');
  await p.disconnect();
});
