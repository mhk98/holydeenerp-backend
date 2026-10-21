import { z } from 'zod';
import { boolFilter, code, email, name, optionalText, phone } from '../settings/settings.schemas.js';

export const createBranchSchema = z.object({
  name: name(),
  code: code(),
  email,
  phone,
  address: optionalText(1000),
  isHeadOffice: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateBranchSchema = createBranchSchema.partial();

export const listBranchQuery = z.object({ isActive: boolFilter, isHeadOffice: boolFilter }).passthrough();
