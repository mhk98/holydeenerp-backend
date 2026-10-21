import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { DISCOUNT_TYPES, FREQUENCIES, RETURN_TYPES } from './sales.model.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalDate = date
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);
const qty = decimalString({ scale: 4 });
const amount = decimalString({ allowZero: true, scale: 4 });
const notes = optionalText(500);
const items = (line) => z.array(line).min(1, 'Add at least one item').max(500);
const serials = z.array(z.string().trim().min(1).max(100)).max(1000).optional();

/** A priced line. Leave unitPrice out to take it from the customer's price list. */
const pricedLine = {
  productId: idSchema,
  variantId: idSchema.nullish(),
  unitId: idSchema.nullish(),
  quantity: qty,
  unitPrice: amount.optional(),
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountValue: amount.optional(),
  taxGroupId: idSchema.nullish(),
  priceIncludesTax: z.boolean().optional(),
  notes,
};
const documentDiscount = {
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountValue: amount.optional(),
};

export const creditOverrideSchema = z.object({
  /** Needed (with sales.approve) when the customer's credit limit would be exceeded. */
  creditOverride: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }).optional(),
});

export const quotationSchema = z.object({
  customerId: idSchema,
  quotationDate: date.optional(),
  validUntil: optionalDate,
  customerReference: optionalText(100),
  notes: optionalText(2000),
  terms: optionalText(5000),
  ...documentDiscount,
  items: items(z.object(pricedLine)),
});

export const orderSchema = z.object({
  customerId: idSchema,
  warehouseId: idSchema,
  orderDate: date.optional(),
  deliveryDate: optionalDate,
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  customerReference: optionalText(100),
  shippingAddress: optionalText(500),
  notes: optionalText(2000),
  terms: optionalText(5000),
  ...documentDiscount,
  items: items(z.object(pricedLine)),
});

export const challanSchema = z.object({
  customerId: idSchema,
  warehouseId: idSchema,
  orderId: idSchema.nullish(),
  challanDate: date.optional(),
  shippingAddress: optionalText(500),
  vehicleNo: optionalText(50),
  driverName: optionalText(100),
  notes: optionalText(2000),
  items: items(
    z.object({
      productId: idSchema,
      variantId: idSchema.nullish(),
      unitId: idSchema.nullish(),
      quantity: qty,
      orderItemId: idSchema.nullish(),
      batchId: idSchema.nullish(),
      serialNumbers: serials,
      notes,
    }),
  ),
});

export const invoiceSchema = z.object({
  customerId: idSchema,
  /** Stock source for lines that are not delivered by a challan. */
  warehouseId: idSchema.nullish(),
  orderId: idSchema.nullish(),
  challanId: idSchema.nullish(),
  invoiceDate: date.optional(),
  dueDate: optionalDate,
  customerReference: optionalText(100),
  notes: optionalText(2000),
  terms: optionalText(5000),
  ...documentDiscount,
  items: items(
    z.object({
      ...pricedLine,
      orderItemId: idSchema.nullish(),
      challanItemId: idSchema.nullish(),
      batchId: idSchema.nullish(),
      serialNumbers: serials,
    }),
  ),
});

const allocations = z
  .array(z.object({ invoiceId: idSchema, amount: decimalString({ scale: 4 }) }))
  .max(200)
  .default([]);

export const receiptSchema = z.object({
  customerId: idSchema,
  paymentMethodId: idSchema,
  receiptDate: date.optional(),
  amount: decimalString({ scale: 4 }),
  reference: optionalText(100),
  notes: optionalText(2000),
  allocations,
});

export const applyCreditSchema = z.object({
  sourceType: z.enum(['receipt', 'credit_note']),
  sourceId: idSchema,
  allocations: allocations.refine((a) => a.length > 0, 'Choose at least one invoice'),
});

export const returnSchema = z.object({
  type: z.enum(RETURN_TYPES),
  customerId: idSchema,
  warehouseId: idSchema.nullish(),
  invoiceId: idSchema.nullish(),
  returnDate: date.optional(),
  reason: optionalText(255),
  notes: optionalText(2000),
  ...documentDiscount,
  items: items(
    z.object({
      ...pricedLine,
      invoiceItemId: idSchema.nullish(),
      batchId: idSchema.nullish(),
      serialNumbers: serials,
    }),
  ),
});

export const priceListSchema = z.object({
  name: name(150),
  code: code(),
  customerGroupId: idSchema.nullish(),
  validFrom: optionalDate,
  validTo: optionalDate,
  priority: z.coerce.number().int().min(-100).max(100).optional(),
  isActive: z.boolean().optional(),
  notes: optionalText(500),
  items: z
    .array(
      z
        .object({
          productId: idSchema,
          variantId: idSchema.nullish(),
          unitId: idSchema.nullish(),
          price: amount.nullish(),
          discountPercent: decimalString({ allowZero: true, scale: 4, max: 100 }).nullish(),
          minQuantity: amount.optional(),
        })
        .refine((i) => i.price != null || i.discountPercent != null, {
          message: 'Enter a price or a discount %',
          path: ['price'],
        }),
    )
    .max(2000)
    .default([]),
});

export const pricesQuery = z.object({
  customerId: idSchema.nullish(),
  date: date.optional(),
  items: z
    .array(
      z.object({
        productId: idSchema,
        variantId: idSchema.nullish(),
        unitId: idSchema.nullish(),
        quantity: amount.optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const calculateSchema = z.object({
  ...documentDiscount,
  items: z.array(z.object({ ...pricedLine, productId: idSchema.optional(), unitPrice: amount })).max(500),
});

export const emailSchema = z.object({
  to: z.array(z.string().trim().email('Enter valid email addresses')).min(1, 'Enter a recipient').max(10),
  cc: z.array(z.string().trim().email('Enter valid email addresses')).max(10).default([]),
  subject: z.string().trim().min(1).max(200),
  message: z.string().max(5000).default(''),
  pdfBase64: z
    .string()
    .max(14_000_000, 'The PDF is too large')
    .regex(/^[A-Za-z0-9+/=\s]+$/, 'Invalid attachment'),
  filename: z
    .string()
    .trim()
    .regex(/^[\w.\- ]{1,100}\.pdf$/, 'Invalid file name'),
});

export const remindSchema = z.object({
  to: z.array(z.string().trim().email('Enter valid email addresses')).max(10).optional(),
  message: z.string().trim().max(5000).optional(),
});

export const convertWarehouseSchema = z.object({ warehouseId: idSchema });
export const returnFromInvoiceSchema = z.object({ type: z.enum(RETURN_TYPES).default('return') });

export const recurringSchema = z.object({
  name: optionalText(150).transform((v) => v ?? undefined),
  frequency: z.enum(FREQUENCIES),
  intervalCount: z.coerce.number().int().min(1).max(12).optional(),
  startDate: date.optional(),
  endDate: optionalDate,
  autoPost: z.boolean().optional(),
  autoEmail: z.boolean().optional(),
});
export const recurringUpdateSchema = z.object({
  name: name(150).optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  intervalCount: z.coerce.number().int().min(1).max(12).optional(),
  nextRunDate: date.optional(),
  endDate: optionalDate,
  autoPost: z.boolean().optional(),
  autoEmail: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const voidSchema = z.object({ reason: z.string().trim().min(1, 'Enter a reason').max(500) });

export const listQuery = z
  .object({
    status: z.string().optional(),
    customerId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    orderId: idSchema.optional(),
    invoiceId: idSchema.optional(),
    type: z.enum(RETURN_TYPES).optional(),
    from: date.optional(),
    to: date.optional(),
    overdue: boolFilter,
  })
  .passthrough();
export const ledgerQuery = z.object({ from: date.optional(), to: date.optional() }).passthrough();
export const agingQuery = z
  .object({
    asOf: date.optional(),
    basis: z.enum(['due_date', 'invoice_date']).default('due_date'),
    customerId: idSchema.optional(),
  })
  .passthrough();
export const customerParams = z.object({ customerId: idSchema });
