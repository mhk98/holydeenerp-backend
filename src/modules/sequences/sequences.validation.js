import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, name } from '../settings/settings.schemas.js';
import { DOC_TYPES } from './sequences.service.js';

const affix = z
  .string()
  .max(50)
  .regex(
    /^[A-Za-z0-9/._\-{}#]*$/,
    'Use letters, numbers, / . _ - # and tokens like {BRANCH} {YYYY} {YY} {MM}',
  )
  .refine(
    (v) => !/\{(?!BRANCH\}|YYYY\}|YY\}|MM\})/.test(v),
    'Unknown token — use {BRANCH}, {YYYY}, {YY} or {MM}',
  );

export const createSequenceSchema = z.object({
  docType: z.enum(DOC_TYPES),
  name: name(100),
  branchId: idSchema.nullish().transform((v) => v ?? null),
  prefix: affix.optional(),
  suffix: affix.optional(),
  padding: z.coerce.number().int().min(1).max(10).optional(),
  nextNumber: z.coerce.number().int().min(1).max(4_000_000_000).optional(),
  resetYearly: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateSequenceSchema = createSequenceSchema.partial();

export const listSequenceQuery = z
  .object({ docType: z.enum(DOC_TYPES).optional(), branchId: idSchema.optional(), isActive: boolFilter })
  .passthrough();

export const previewSchema = z.object({
  branchId: idSchema.nullish(),
  prefix: affix.default(''),
  suffix: affix.default(''),
  padding: z.coerce.number().int().min(1).max(10).default(5),
  nextNumber: z.coerce.number().int().min(1).default(1),
});
