import crypto from 'node:crypto';
import { env } from '../config/env.js';

/** URL-safe random token (refresh tokens, password reset tokens). */
export function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest — tokens are stored hashed, never in plain text. */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/** AES-256-GCM encryption for secrets at rest (e.g. TOTP secrets). Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, data] = String(payload)
    .split('.')
    .map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
