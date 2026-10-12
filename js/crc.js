// CRC-16/CCITT (polynomial 0x1021, start 0xFFFF): the check the pulsetest bootloader,
// the power-line messages and the ID card all use.
export function crc16(bytes, c = 0xffff) {
  for (const b of bytes) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
