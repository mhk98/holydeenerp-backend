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
import { DISCOUNT_TYPES } from '../sales/sales.model.js';
import { RECEIPT_PAPERS } from './pos.model.js';

const amount = decimalString({ allowZero: true, scale: 4 });
const positive = decimalString({ scale: 4 });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const registerSchema = z.object({
  name: name(100),
  code: code(),
  warehouseId: idSchema,
  defaultCustomerId: idSchema.nullish(),
  receiptPaper: z.enum(RECEIPT_PAPERS).optional(),
  isActive: z.boolean().optional(),
  notes: optionalText(500),
});

export const registerQuery = z.object({ registerId: idSchema });
export const bootstrapQuery = z.object({ registerId: idSchema.optional() });

export const openSessionSchema = z.object({
  registerId: idSchema,
  openingCash: amount.default('0'),
  notes: optionalText(500),
});

export const cashMovementSchema = z.object({
  type: z.enum(['in', 'out']),
  amount: positive,
  reason: z.string().trim().min(2, 'Give a reason').max(255),
});

export const closeSessionSchema = z
  .object({
    /** Count per denomination: { "1000": 3, "500": 2 } */
    denominations: z.record(z.string(), z.coerce.number().int().min(0).max(100000)).optional(),
    countedCash: amount.optional(),
    notes: optionalText(500),
  })
  .refine((v) => v.denominations || v.countedCash != null, {
    message: 'Count the cash in the drawer',
    path: ['denominations'],
  });

export const sessionListQuery = z
  .object({
    registerId: idSchema.optional(),
    status: z.enum(['open', 'closed']).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

const saleLine = z.object({
  productId: idSchema,
  variantId: idSchema.nullish(),
  unitId: idSchema.nullish(),
  quantity: positive,
  unitPrice: amount,
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountValue: amount.optional(),
  taxGroupId: idSchema.nullish(),
  priceIncludesTax: z.boolean().optional(),
  batchId: idSchema.nullish(),
  serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
  notes: optionalText(500),
});

export const saleSchema = z.object({
  /** Generated on the device; the same sale synced twice is created once. */
  clientUuid: z.string().uuid('Invalid sale id'),
  registerId: idSchema,
  sessionId: idSchema,
  customerId: idSchema.nullish(),
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountValue: amount.optional(),
  notes: optionalText(500),
  items: z.array(saleLine).min(1, 'Add at least one item').max(300),
  payments: z
    .array(
      z.object({
        paymentMethodId: idSchema,
        amount: positive,
        reference: optionalText(100),
      }),
    )
    .max(10)
    .default([]),
  /** Store credit from a return (exchange). */
  credits: z
    .array(z.object({ returnId: idSchema, amount: positive }))
    .max(5)
    .default([]),
  creditOverride: z.object({ reason: z.string().trim().min(3).max(500) }).optional(),
  /** Set when the sale was made offline: the number printed on the receipt and when it was sold. */
  offline: z
    .object({
      number: z.string().max(40).nullish(),
      soldAt: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
});

export const syncSchema = z.object({
  sales: z.array(saleSchema).min(1).max(100),
});

export const lookupQuery = z.object({ number: z.string().trim().min(1).max(60) });

export const returnSchema = z.object({
  registerId: idSchema,
  sessionId: idSchema,
  reason: optionalText(255),
  items: z
    .array(z.object({ invoiceItemId: idSchema, quantity: positive }))
    .min(1, 'Choose at least one item to return'),
  /** Pay the credit back now; leave out to keep it for an exchange. */
  refund: z.object({ paymentMethodId: idSchema, amount: positive.optional() }).optional(),
});

export const holdSchema = z.object({
  registerId: idSchema,
  label: z.string().trim().min(1).max(100),
  customerId: idSchema.nullish(),
  cart: z.record(z.string(), z.unknown()),
  total: amount.optional(),
});

export const quickCustomerSchema = z.object({ name: name(200), phone, email });

export const listQuery = z.object({ isActive: boolFilter }).passthrough();
