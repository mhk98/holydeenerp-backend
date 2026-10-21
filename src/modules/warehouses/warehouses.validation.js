import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, name, optionalText, phone } from '../settings/settings.schemas.js';

export const createWarehouseSchema = z.object({
  branchId: idSchema,
  name: name(),
  code: code(),
  phone,
  address: optionalText(1000),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updateWarehouseSchema = createWarehouseSchema.partial();

export const listWarehouseQuery = z
  .object({ branchId: idSchema.optional(), isActive: boolFilter })
  .passthrough();
