/**
 * RFC 6238 TOTP (Time-Based One-Time Password) implementation in pure Node.js.
 * Zero external dependencies.
 *
 * Supports SHA-256 (used by Certum SimplySign), SHA-1, and SHA-512.
 */

import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decodes a Base32 encoded string into a Buffer.
 * Handles spaces, hyphens, lowercase characters, and padding '='.
 *
 * @param {string} secret - Base32 encoded secret string
 * @returns {Buffer} - Decoded secret key as Buffer
 */
export function base32Decode(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('TOTP secret must be a non-empty string');
  }

  const cleaned = secret.trim().replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (cleaned.length === 0) {
    throw new Error('TOTP secret contains no valid Base32 characters');
  }

  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid character '${char}' found in Base32 secret`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/**
 * Generates a Time-Based One-Time Password (TOTP) compliant with RFC 6238.
 *
 * @param {string} secret - Base32 encoded secret string
 * @param {Object} [options]
 * @param {string} [options.algorithm='SHA-256'] - Hashing algorithm ('SHA-256', 'SHA-1', 'SHA-512')
 * @param {number} [options.digits=6] - Number of digits in generated OTP (usually 6 or 8)
 * @param {number} [options.period=30] - Time interval in seconds
 * @param {number} [options.timestamp] - Unix epoch timestamp in seconds (defaults to current time)
 * @returns {string} - Generated OTP string (zero-padded)
 */
export function generateTOTP(secret, options = {}) {
  const {
    algorithm = 'SHA-256',
    digits = 6,
    period = 30,
    timestamp = Math.floor(Date.now() / 1000)
  } = options;

  if (digits < 6 || digits > 10) {
    throw new Error(`Invalid digits count: ${digits}. Must be between 6 and 10.`);
  }

  if (period <= 0) {
    throw new Error(`Invalid period: ${period}. Must be greater than 0.`);
  }

  const key = base32Decode(secret);

  // Normalize algorithm name for Node.js crypto
  const normAlgo = algorithm.toUpperCase().replace(/[-_]/g, '');
  let nodeAlgo;
  if (normAlgo === 'SHA1') {
    nodeAlgo = 'sha1';
  } else if (normAlgo === 'SHA256') {
    nodeAlgo = 'sha256';
  } else if (normAlgo === 'SHA512') {
    nodeAlgo = 'sha512';
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}. Supported: SHA-1, SHA-256, SHA-512.`);
  }

  // Calculate counter based on timestamp and period
  const counter = Math.floor(timestamp / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  // Compute HMAC with in-memory key zeroing
  let hmac;
  try {
    hmac = crypto.createHmac(nodeAlgo, key).update(counterBuf).digest();
  } finally {
    key.fill(0);
  }

  // Dynamic truncation (RFC 4226 / RFC 6238)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff);
  const code = binary % (10 ** digits);

  return code.toString().padStart(digits, '0');
}
