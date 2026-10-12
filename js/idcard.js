// The ID card: 32 bytes in the chip's user row, written by the Initialisation Station.
// The user row survives re-flashing and chip erase, so a drive keeps its number for life.
//
//   0-3   "SYN1"
//   4     card version (1)
//   5     family: 'C' (Core) or 'P' (Pulse)
//   6-7   drive number (little-endian)
//   8     board code (see BOARDS)
//   9-12  casing code, 4 characters
//   13-14 date initialised, days since 1 Jan 2026
//   15-29 spare (0xFF)
//   30-31 CRC-16/CCITT of bytes 0-29
//
// The station hello (Stage 2) sends bytes 5-8 back to the station: family, number, board.

import { crc16 } from './crc.js';

export const BOARDS = {
  0x10: { code: 'Core A', family: 'C' },
  0x11: { code: 'Core B', family: 'C' },
  0x20: { code: 'Pulse A', family: 'P' },
  0x21: { code: 'Pulse A1', family: 'P' },
  0x22: { code: 'Pulse A2', family: 'P' },
  0x23: { code: 'Pulse B', family: 'P' },
};
export const boardCode = (name) => Number(Object.keys(BOARDS).find((k) => BOARDS[k].code === name));

const EPOCH = Date.UTC(2026, 0, 1);

export function driveLabel(family, number) {
  return `${family}-${String(number).padStart(4, '0')}`;
}

export function encodeCard({ family, number, board, casing = '', date = new Date() }) {
  if (family !== 'C' && family !== 'P') throw new Error('Family must be C or P');
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('Drive number must be 1–65535');
  const code = boardCode(board);
  if (!code) throw new Error(`Unknown board ${board}`);
  const c = new Uint8Array(32).fill(0xff);
  c.set([0x53, 0x59, 0x4e, 0x31], 0); // "SYN1"
  c[4] = 1;
  c[5] = family.charCodeAt(0);
  c[6] = number & 0xff;
  c[7] = number >> 8;
  c[8] = code;
  const cas = (casing.toUpperCase().replace(/[^A-Z0-9-]/g, '') + '    ').slice(0, 4);
  for (let i = 0; i < 4; i++) c[9 + i] = cas.charCodeAt(i);
  const days = Math.max(0, Math.min(65535, Math.floor((date.getTime() - EPOCH) / 86400000)));
  c[13] = days & 0xff;
  c[14] = days >> 8;
  const crc = crc16(c.subarray(0, 30));
  c[30] = crc & 0xff;
  c[31] = crc >> 8;
  return c;
}

// Returns null for a blank or unreadable row.
export function decodeCard(row) {
  if (!row || row.length < 32) return null;
  if (String.fromCharCode(...row.subarray(0, 4)) !== 'SYN1') return null;
  if (crc16(row.subarray(0, 30)) !== (row[30] | (row[31] << 8))) return null;
  const family = String.fromCharCode(row[5]);
  const number = row[6] | (row[7] << 8);
  const days = row[13] | (row[14] << 8);
  return {
    version: row[4],
    family,
    number,
    label: driveLabel(family, number),
    board: BOARDS[row[8]] ? BOARDS[row[8]].code : `board ${row[8]}`,
    casing: String.fromCharCode(...row.subarray(9, 13)).trim(),
    date: new Date(EPOCH + days * 86400000).toISOString().slice(0, 10),
  };
}
