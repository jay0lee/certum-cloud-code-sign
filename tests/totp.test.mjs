/**
 * Test suite for RFC 6238 TOTP module.
 * Tests RFC 6238 test vectors and edge cases.
 */

if (typeof console === 'undefined' && typeof print !== 'undefined') {
  globalThis.console = { log: print, error: print };
}

import { generateTOTP, base32Decode } from '../scripts/totp.mjs';

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message} -> expected "${expected}", got "${actual}"`);
    failed++;
  }
}

function assertThrows(fn, expectedMsgSubstring, message) {
  try {
    fn();
    console.error(`  ✗ ${message} -> expected error to be thrown`);
    failed++;
  } catch (err) {
    if (err.message.includes(expectedMsgSubstring)) {
      console.log(`  ✓ ${message}`);
      passed++;
    } else {
      console.error(`  ✗ ${message} -> wrong error message: "${err.message}"`);
      failed++;
    }
  }
}

console.log('Testing Base32 decoding:');
const rfc32Key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====';
const decoded = base32Decode(rfc32Key);
assertEqual(decoded.toString('ascii'), '12345678901234567890123456789012', 'Decodes RFC 32-byte key correctly');

const unpaddedKey = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const decodedUnpadded = base32Decode(unpaddedKey);
assertEqual(decodedUnpadded.toString('ascii'), '12345678901234567890123456789012', 'Decodes unpadded key correctly');

const spacedKey = 'gez d-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq-gezd-gnbv-gy3t-qojq-geza';
const decodedSpaced = base32Decode(spacedKey);
assertEqual(decodedSpaced.toString('ascii'), '12345678901234567890123456789012', 'Handles spaces, hyphens, and lowercase');

assertThrows(() => base32Decode(''), 'non-empty', 'Rejects empty string');
assertThrows(() => base32Decode('INVALID89!'), 'Invalid character', 'Rejects invalid Base32 character');

console.log('\nTesting RFC 6238 SHA-256 test vectors:');
// RFC 6238 Appendix B Table 1 test vectors for SHA-256
// Secret: '12345678901234567890123456789012' -> Base32: rfc32Key
assertEqual(
  generateTOTP(rfc32Key, { algorithm: 'SHA-256', digits: 8, period: 30, timestamp: 1111111109 }),
  '68084774',
  'RFC 6238 SHA-256 at t=1111111109 (8 digits)'
);

assertEqual(
  generateTOTP(rfc32Key, { algorithm: 'SHA-256', digits: 8, period: 30, timestamp: 1234567890 }),
  '91819424',
  'RFC 6238 SHA-256 at t=1234567890 (8 digits)'
);

assertEqual(
  generateTOTP(rfc32Key, { algorithm: 'SHA-256', digits: 6, period: 30, timestamp: 1234567890 }),
  '819424',
  'Certum style 6-digit SHA-256 at t=1234567890'
);

console.log('\nTesting RFC 6238 SHA-1 test vectors:');
// 20-byte key: '12345678901234567890' -> Base32: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const rfc20Key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
assertEqual(
  generateTOTP(rfc20Key, { algorithm: 'SHA-1', digits: 8, period: 30, timestamp: 59 }),
  '94287082',
  'RFC 6238 SHA-1 at t=59 (8 digits)'
);

assertEqual(
  generateTOTP(rfc20Key, { algorithm: 'SHA-1', digits: 8, period: 30, timestamp: 1111111109 }),
  '07081804',
  'RFC 6238 SHA-1 at t=1111111109 (8 digits)'
);

assertEqual(
  generateTOTP(rfc20Key, { algorithm: 'SHA-1', digits: 8, period: 30, timestamp: 1234567890 }),
  '89005924',
  'RFC 6238 SHA-1 at t=1234567890 (8 digits)'
);

assertEqual(
  generateTOTP(rfc20Key, { algorithm: 'SHA-1', digits: 6, period: 30, timestamp: 1234567890 }),
  '005924',
  'Standard 6-digit SHA-1 at t=1234567890'
);

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
