import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import {
  boolFilter,
  code,
  decimalString,
  email,
  name,
  optionalText,
  phone,
} from '../settings/settings.schemas.js';
import { ADDRESS_TYPES } from './party.model.js';

const address = z.object({
  type: z.enum(ADDRESS_TYPES),
  label: optionalText(60),
  addressLine: z.string().trim().min(1, 'Address is required').max(500),
  city: optionalText(100),
  district: optionalText(100),
  postalCode: optionalText(20),
  country: z.string().trim().max(60).optional(),
  phone,
  isDefault: z.boolean().optional(),
});

export const partySchema = z.object({
  /** Leave empty to generate (CUS-00001 / SUP-00001). */
  code: code()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  name: name(200),
  contactPerson: optionalText(150),
  phone,
  email,
  binNo: optionalText(50),
  tinNo: optionalText(50),
  groupId: idSchema.nullish(),
  creditLimit: decimalString({ allowZero: true, scale: 4 }).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  openingBalance: decimalString({ allowZero: true, scale: 4 }).optional(),
  openingBalanceType: z.enum(['debit', 'credit']).optional(),
  notes: optionalText(5000),
  isActive: z.boolean().optional(),
  /** A customer can also be marked as a supplier (and vice versa). */
  alsoOtherRole: z.boolean().optional(),
  addresses: z.array(address).max(20).optional(),
});

export const updatePartySchema = partySchema.partial();

export const listPartyQuery = z.object({ groupId: idSchema.optional(), isActive: boolFilter }).passthrough();

export const groupSchema = z.object({
  name: name(100),
  code: code(),
  description: optionalText(),
  isActive: z.boolean().optional(),
});
export const updateGroupSchema = groupSchema.partial();
