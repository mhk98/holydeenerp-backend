import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, name, optionalText } from '../settings/settings.schemas.js';

export const createCategorySchema = z.object({
  name: name(150),
  code: code(),
  parentId: idSchema.nullish().transform((v) => v ?? null),
  description: optionalText(500),
  sortOrder: z.coerce.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
export const updateCategorySchema = createCategorySchema.partial();
export const listCategoryQuery = z
  .object({ parentId: idSchema.optional(), isActive: boolFilter })
  .passthrough();

export const moveSchema = z.object({
  items: z
    .array(
      z.object({
        id: idSchema,
        parentId: idSchema.nullish().transform((v) => v ?? null),
        sortOrder: z.coerce.number().int().min(0).max(100000),
      }),
    )
    .min(1)
    .max(1000),
});
