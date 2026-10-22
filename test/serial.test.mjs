import test from 'node:test';
import assert from 'node:assert/strict';
import { portKind } from '../js/serial.js';

test('portKind tells the UPDI Friend from the station box', () => {
  assert.equal(portKind({ usbVendorId: 0x1a86, usbProductId: 0x7523 }), 'friend');
  assert.equal(portKind({ usbVendorId: 0x2e8a, usbProductId: 0x000a }), 'station');
  assert.equal(portKind({ usbVendorId: 0x2886, usbProductId: 0x0042 }), 'station');
  assert.equal(portKind({ usbVendorId: 0x0403 }), null);
  assert.equal(portKind({}), null);
});
