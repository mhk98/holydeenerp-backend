import crypto from 'node:crypto';

/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12) {
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

export const isValidEan13 = (code) =>
  /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];

/** CODE128 (set B): printable ASCII, practical length for labels. */
export const isValidCode128 = (code) => /^[\x20-\x7E]{1,48}$/.test(code);

export function isValidBarcode(code, type) {
  return type === 'EAN13' ? isValidEan13(code) : isValidCode128(code);
}

/**
 * Random in-store EAN-13. The "2" prefix is reserved by GS1 for restricted / in-store use,
 * so generated codes never collide with manufacturers' barcodes.
 */
export function randomInStoreEan13() {
  const body = `2${String(crypto.randomInt(0, 1e11)).padStart(11, '0')}`;
  return body + ean13CheckDigit(body);
}
