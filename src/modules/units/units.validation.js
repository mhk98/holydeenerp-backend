import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, decimalString, name } from '../settings/settings.schemas.js';
import { UNIT_CATEGORIES } from './unit.model.js';

export const createUnitSchema = z.object({
  name: name(60),
  code: z
    .string({ error: 'Code is required' })
    .trim()
    .min(1, 'Code is required')
    .max(20)
    .regex(/^[A-Za-z0-9.²³/_-]+$/, 'Use letters, numbers and . / _ -'),
  category: z.enum(UNIT_CATEGORIES),
  allowDecimal: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
export const updateUnitSchema = createUnitSchema.partial();
export const listUnitQuery = z
  .object({ category: z.enum(UNIT_CATEGORIES).optional(), isActive: boolFilter })
  .passthrough();

export const createConversionSchema = z.object({
  fromUnitId: idSchema,
  toUnitId: idSchema,
  factor: decimalString({ scale: 6 }),
});
export const listConversionQuery = z.object({ unitId: idSchema.optional() }).passthrough();
