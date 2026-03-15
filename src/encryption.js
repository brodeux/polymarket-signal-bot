/**
 * AES-256-GCM encryption for private key storage.
 * Keys are encrypted with a server-side ENCRYPTION_KEY before being stored in the DB.
 * The raw private key is never written to disk or logs.
 */

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getMasterKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set in .env');
  if (key.length !== 64) throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt a plaintext string. Returns a hex string: iv:authTag:ciphertext
 */
export function encrypt(plaintext) {
  const masterKey = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a string produced by encrypt(). Returns the original plaintext.
 */
export function decrypt(encoded) {
  const masterKey = getMasterKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}
