import { z } from 'zod';

/** Reusable Zod building blocks for Settings resources. */

export const code = (max = 30) =>
  z
    .string({ error: 'Code is required' })
    .trim()
    .min(1, 'Code is required')
    .max(max)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore');

export const name = (max = 150) =>
  z.string({ error: 'Name is required' }).trim().min(1, 'Name is required').max(max);

export const optionalText = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const phone = optionalText(30).refine(
  (v) => !v || /^[0-9+\-\s()]*$/.test(v),
  'Enter a valid phone number',
);

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(191)
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);

/** Positive decimal kept as a string (money/rates never pass through floats). */
export const decimalString = ({ max = 999999999999, allowZero = false, scale = 6 } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine(
      (v) => new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`).test(v),
      `Enter a number with up to ${scale} decimals`,
    )
    .refine(
      (v) => (allowZero ? Number(v) >= 0 : Number(v) > 0),
      allowZero ? 'Must be 0 or more' : 'Must be greater than 0',
    )
    .refine((v) => Number(v) <= max, `Must be at most ${max}`);

/** Query-string boolean filter ("true"/"false"). */
export const boolFilter = z.enum(['true', 'false']).optional();

/** Make every key optional for PATCH and drop server-controlled defaults. */
export const toUpdate = (schema) => schema.partial();
