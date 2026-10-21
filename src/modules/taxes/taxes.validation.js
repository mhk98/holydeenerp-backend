import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { TAX_TYPES } from './tax.model.js';

const percent = decimalString({ max: 100, allowZero: true, scale: 4 });

export const createTaxRateSchema = z.object({
  name: name(100),
  code: code(),
  type: z.enum(TAX_TYPES),
  rate: percent,
  description: optionalText(),
  isActive: z.boolean().optional(),
});
export const updateTaxRateSchema = createTaxRateSchema.partial();
export const listTaxRateQuery = z
  .object({ type: z.enum(TAX_TYPES).optional(), isActive: boolFilter })
  .passthrough();

const groupRate = z.object({
  taxRateId: idSchema,
  isCompound: z.boolean().optional().default(false),
});

export const createTaxGroupSchema = z.object({
  name: name(100),
  code: code(),
  description: optionalText(),
  isActive: z.boolean().optional(),
  /** Order of the array is the order taxes are applied. */
  rates: z
    .array(groupRate)
    .refine((r) => new Set(r.map((x) => x.taxRateId)).size === r.length, 'A rate can only be added once'),
});
export const updateTaxGroupSchema = createTaxGroupSchema.partial();
export const listTaxGroupQuery = z.object({ isActive: boolFilter }).passthrough();

export const calculateSchema = z.object({
  amount: decimalString({ allowZero: true, scale: 4 }),
  inclusive: z.boolean().optional().default(false),
});
