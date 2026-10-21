import { calculateTax } from '../src/modules/taxes/tax.calculator.js';
import { formatNumber } from '../src/modules/sequences/sequences.service.js';
import { cronExpression } from '../src/modules/backups/backups.scheduler.js';
import { closeDatabase } from '../src/config/db.js';

afterAll(() => closeDatabase());

const VAT15 = { name: 'VAT 15%', rate: '15', isCompound: false };
const SD20 = { name: 'SD 20%', rate: '20', isCompound: false };

describe('calculateTax', () => {
  it('adds VAT on top of an exclusive price', () => {
    const r = calculateTax({ amount: '1000', rates: [VAT15] });
    expect(r).toMatchObject({
      netAmount: '1000.00',
      totalTax: '150.00',
      total: '1150.00',
      effectiveRate: '15.0000',
    });
  });

  it('charges compound VAT on the SD-inclusive value (Bangladesh rule)', () => {
    const r = calculateTax({ amount: '1000', rates: [SD20, { ...VAT15, isCompound: true }] });
    expect(r.taxes.map((t) => [t.taxableAmount, t.amount])).toEqual([
      ['1000.00', '200.00'],
      ['1200.00', '180.00'],
    ]);
    expect(r).toMatchObject({ totalTax: '380.00', total: '1380.00', effectiveRate: '38.0000' });
  });

  it('backs the net out of an inclusive price', () => {
    expect(calculateTax({ amount: '1150', inclusive: true, rates: [VAT15] })).toMatchObject({
      netAmount: '1000.00',
      totalTax: '150.00',
      total: '1150.00',
    });
    expect(
      calculateTax({ amount: '1380', inclusive: true, rates: [SD20, { ...VAT15, isCompound: true }] }),
    ).toMatchObject({ netAmount: '1000.00', totalTax: '380.00' });
  });

  it('keeps net + tax equal to an inclusive price after rounding', () => {
    const r = calculateTax({ amount: '100', inclusive: true, rates: [VAT15] });
    expect(r).toMatchObject({ netAmount: '86.96', totalTax: '13.04', total: '100.00' });
  });

  it('applies rates in sequence order and honours precision', () => {
    const r = calculateTax({
      amount: '99.99',
      decimals: 4,
      rates: [
        { ...VAT15, sequence: 2, isCompound: true },
        { ...SD20, sequence: 1 },
      ],
    });
    expect(r.taxes.map((t) => t.name)).toEqual(['SD 20%', 'VAT 15%']);
    expect(r.total).toBe('137.9862');
  });

  it('handles no taxes', () => {
    expect(calculateTax({ amount: '50', rates: [] })).toMatchObject({ totalTax: '0.00', total: '50.00' });
  });
});

describe('formatNumber', () => {
  const tokens = { branchCode: 'DHK', year: 2026, month: '07' };

  it('formats prefix tokens and padding', () => {
    expect(formatNumber({ prefix: 'INV-{BRANCH}-{YYYY}-', suffix: '', padding: 5 }, 1, tokens)).toBe(
      'INV-DHK-2026-00001',
    );
    expect(formatNumber({ prefix: 'POS-{YY}{MM}-', suffix: '/{BRANCH}', padding: 4 }, 42, tokens)).toBe(
      'POS-2607-0042/DHK',
    );
  });

  it('does not truncate numbers longer than the padding', () => {
    expect(formatNumber({ prefix: 'X', suffix: '', padding: 2 }, 12345, tokens)).toBe('X12345');
  });
});

describe('cronExpression', () => {
  it('builds daily and weekly schedules', () => {
    expect(cronExpression({ frequency: 'daily', time: '02:30', weekday: 5 })).toBe('30 2 * * *');
    expect(cronExpression({ frequency: 'weekly', time: '23:05', weekday: 5 })).toBe('5 23 * * 5');
  });
});
