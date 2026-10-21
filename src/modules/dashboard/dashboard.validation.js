import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter } from '../settings/settings.schemas.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const dashboardQuery = z
  .object({
    range: z.enum(['today', 'week', 'month', 'custom']).default('month'),
    from: date.optional(),
    to: date.optional(),
    branchId: idSchema.optional(),
    refresh: boolFilter,
  })
  .refine((q) => q.range !== 'custom' || (q.from && q.to), { path: ['from'], message: 'Choose both dates' })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'The end is before the start' })
  .refine((q) => !q.from || !q.to || Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    path: ['to'],
    message: 'Choose at most a year',
  });
