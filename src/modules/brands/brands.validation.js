import { z } from 'zod';
import { boolFilter, code, name, optionalText } from '../settings/settings.schemas.js';

export const createBrandSchema = z.object({
  name: name(150),
  code: code(),
  description: optionalText(500),
  isActive: z.boolean().optional(),
});
export const updateBrandSchema = createBrandSchema.partial();
export const listBrandQuery = z.object({ isActive: boolFilter }).passthrough();
