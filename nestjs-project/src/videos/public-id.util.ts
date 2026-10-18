import { randomBytes } from 'node:crypto';

const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_PATTERN = /^[0-9A-Za-z]{11}$/;

// Largest multiple of 62 that fits in a byte (62 * 4 = 248); bytes at or above it are
// discarded so every character is equally likely (no modulo bias).
const UNBIASED_BYTE_LIMIT = 248;

export function generatePublicId(): string {
  let id = '';
  while (id.length < PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(PUBLIC_ID_LENGTH * 2)) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      id += BASE62_ALPHABET[byte % BASE62_ALPHABET.length];
      if (id.length === PUBLIC_ID_LENGTH) break;
    }
  }
  return id;
}
