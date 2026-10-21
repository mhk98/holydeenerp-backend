import { z } from 'zod';
import { boolFilter, decimalString, name } from '../settings/settings.schemas.js';

export const createCurrencySchema = z.object({
  code: z
    .string({ error: 'Code is required' })
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'Use the 3-letter ISO code, e.g. USD'),
  name: name(100),
  symbol: z.string({ error: 'Symbol is required' }).trim().min(1, 'Symbol is required').max(10),
  decimalPlaces: z.coerce.number().int().min(0).max(6).optional(),
  isActive: z.boolean().optional(),
});

export const updateCurrencySchema = createCurrencySchema.partial();

export const listCurrencyQuery = z.object({ isActive: boolFilter, isBase: boolFilter }).passthrough();

export const rateSchema = z.object({
  rate: decimalString({ scale: 6 }),
  effectiveDate: z.iso.date('Use the format YYYY-MM-DD').optional(),
});
