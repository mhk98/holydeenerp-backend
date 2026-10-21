import { z } from 'zod';
import { boolFilter, code, name, optionalText } from '../settings/settings.schemas.js';
import { PAYMENT_TYPES } from './payment-method.model.js';

export const createPaymentMethodSchema = z.object({
  name: name(100),
  code: code(),
  type: z.enum(PAYMENT_TYPES),
  provider: optionalText(60),
  accountNumber: optionalText(60),
  requiresReference: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  isActive: z.boolean().optional(),
});
export const updatePaymentMethodSchema = createPaymentMethodSchema.partial();
export const listPaymentMethodQuery = z
  .object({ type: z.enum(PAYMENT_TYPES).optional(), isActive: boolFilter })
  .passthrough();
