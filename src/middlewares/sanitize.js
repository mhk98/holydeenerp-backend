import { filterXSS } from 'xss';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Secrets are compared/hashed byte-for-byte, so they must reach the service unchanged. */
const RAW_KEYS = /password|token|secret/i;

function clean(value) {
  if (typeof value === 'string') return filterXSS(value.trim(), { whiteList: {}, stripIgnoreTag: true });
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) delete value[key];
      else if (!(RAW_KEYS.test(key) && typeof value[key] === 'string')) value[key] = clean(value[key]);
    }
  }
  return value;
}

/**
 * Strips HTML/script from string inputs and blocks prototype-pollution keys.
 * Mutates in place because Express 5 exposes req.query as a read-only getter.
 * SQL injection is handled separately: only parameterized Sequelize queries are allowed.
 */
export function sanitizeInput(req, res, next) {
  if (req.body) clean(req.body);
  if (req.query) clean(req.query);
  if (req.params) clean(req.params);
  next();
}
