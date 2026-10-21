import { z } from 'zod';
import { name } from '../settings/settings.schemas.js';

const values = z
  .array(z.string().trim().min(1).max(60))
  .min(1, 'Add at least one value')
  .max(100)
  .refine((v) => new Set(v.map((x) => x.toLowerCase())).size === v.length, 'Values must be unique');

export const createAttributeSchema = z.object({
  name: name(60),
  sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  values,
});
export const updateAttributeSchema = createAttributeSchema.partial();
