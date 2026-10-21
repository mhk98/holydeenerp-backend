import {
  ean13CheckDigit,
  isValidBarcode,
  isValidCode128,
  isValidEan13,
  randomInStoreEan13,
} from '../src/utils/barcode.js';

describe('barcode utils', () => {
  it('computes EAN-13 check digits', () => {
    expect(ean13CheckDigit('400638133393')).toBe('1'); // 4006381333931
    expect(ean13CheckDigit('590123412345')).toBe('7'); // 5901234123457
    expect(ean13CheckDigit('200000000000')).toBe('8');
  });

  it('validates EAN-13 and CODE128', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan13('400638133393')).toBe(false);
    expect(isValidEan13('40063813339a1')).toBe(false);
    expect(isValidCode128('P-000001')).toBe(true);
    expect(isValidCode128('বাংলা')).toBe(false);
    expect(isValidCode128('')).toBe(false);
    expect(isValidBarcode('5901234123457', 'EAN13')).toBe(true);
    expect(isValidBarcode('ABC 123', 'CODE128')).toBe(true);
  });

  it('generates valid in-store EAN-13 codes', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = randomInStoreEan13();
      expect(code).toMatch(/^2\d{12}$/);
      expect(isValidEan13(code)).toBe(true);
    }
  });
});
