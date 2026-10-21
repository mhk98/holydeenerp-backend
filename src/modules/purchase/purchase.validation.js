import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, decimalString, optionalText } from '../settings/settings.schemas.js';
import { LANDED_COST_TYPES, RETURN_TYPES } from './purchase.model.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalDate = date
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);
const qty = decimalString({ scale: 4 });
const amount = decimalString({ allowZero: true, scale: 4 });
const percent = decimalString({ allowZero: true, scale: 4, max: 100 }).optional();
const notes = optionalText(500);
const items = (line) => z.array(line).min(1, 'Add at least one item').max(500);

const itemBase = {
  productId: idSchema,
  variantId: idSchema.nullish(),
  unitId: idSchema.nullish(),
  quantity: qty,
  notes,
};
const priced = {
  unitPrice: amount,
  discountPercent: percent,
  taxGroupId: idSchema.nullish(),
};

// ── Requisitions ───────────────────────────────────────────────────────────
export const requisitionSchema = z.object({
  warehouseId: idSchema.nullish(),
  requisitionDate: date.optional(),
  requiredBy: optionalDate,
  notes: optionalText(2000),
  items: items(z.object({ ...itemBase, estimatedPrice: amount.nullish() })),
});

export const convertRequisitionToOrderSchema = z.object({
  supplierId: idSchema,
  warehouseId: idSchema.optional(),
});
export const convertRequisitionToRfqSchema = z.object({
  supplierIds: z.array(idSchema).min(1, 'Choose at least one supplier').max(20),
  quoteDeadline: optionalDate,
});

// ── RFQs ───────────────────────────────────────────────────────────────────
export const rfqSchema = z.object({
  rfqDate: date.optional(),
  quoteDeadline: optionalDate,
  notes: optionalText(2000),
  supplierIds: z.array(idSchema).min(1, 'Invite at least one supplier').max(20),
  items: items(z.object({ ...itemBase, requisitionItemId: idSchema.nullish() })),
});

export const rfqQuoteSchema = z.object({
  status: z.enum(['quoted', 'declined']).default('quoted'),
  quoteDate: optionalDate,
  validUntil: optionalDate,
  deliveryDays: z.coerce.number().int().min(0).max(3650).nullish(),
  notes,
  quotes: z
    .array(
      z.object({
        rfqItemId: idSchema,
        unitPrice: amount,
        discountPercent: percent,
        taxGroupId: idSchema.nullish(),
        notes: optionalText(255),
      }),
    )
    .max(500)
    .default([]),
});

export const rfqSupplierParams = z.object({ id: idSchema, rfqSupplierId: idSchema });
export const awardSchema = z.object({ rfqSupplierId: idSchema, warehouseId: idSchema.optional() });

// ── Purchase orders ────────────────────────────────────────────────────────
export const orderSchema = z.object({
  supplierId: idSchema,
  warehouseId: idSchema,
  orderDate: date.optional(),
  expectedDate: optionalDate,
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  supplierReference: optionalText(100),
  notes: optionalText(2000),
  terms: optionalText(5000),
  items: items(z.object({ ...itemBase, ...priced, requisitionItemId: idSchema.nullish() })),
});

export const emailSchema = z.object({
  to: z.array(z.string().trim().email('Enter valid email addresses')).min(1, 'Enter a recipient').max(10),
  cc: z.array(z.string().trim().email('Enter valid email addresses')).max(10).default([]),
  subject: z.string().trim().min(1).max(200),
  message: z.string().max(5000).default(''),
  /** The PDF rendered by the web app, base64 (≤ 5 MB). */
  pdfBase64: z
    .string()
    .max(7_000_000, 'The PDF is too large')
    .regex(/^[A-Za-z0-9+/=\s]+$/, 'Invalid attachment'),
  filename: z
    .string()
    .trim()
    .regex(/^[\w.\- ]{1,100}\.pdf$/, 'Invalid file name'),
});

export const calculateSchema = z.object({
  items: z.array(z.object({ quantity: amount, ...priced })).max(500),
});

// ── Goods receipts ─────────────────────────────────────────────────────────
export const receiptSchema = z.object({
  supplierId: idSchema,
  warehouseId: idSchema,
  orderId: idSchema.nullish(),
  receiptDate: date.optional(),
  supplierReference: optionalText(100),
  notes: optionalText(2000),
  items: items(
    z.object({
      ...itemBase,
      orderItemId: idSchema.nullish(),
      /** Per entered unit, net of discount, excluding tax. Taken from the PO line when linked. */
      unitPrice: amount.optional(),
      taxGroupId: idSchema.nullish(),
      batchId: idSchema.nullish(),
      batchNo: optionalText(60),
      expiryDate: optionalDate,
      mfgDate: optionalDate,
      serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
    }),
  ),
  costs: z
    .array(
      z.object({
        costType: z.enum(LANDED_COST_TYPES),
        description: optionalText(255),
        amount: decimalString({ scale: 4 }),
        allocation: z.enum(['value', 'quantity']).default('value'),
      }),
    )
    .max(20)
    .default([]),
});

// ── Bills ──────────────────────────────────────────────────────────────────
export const billSchema = z.object({
  supplierId: idSchema,
  orderId: idSchema.nullish(),
  receiptId: idSchema.nullish(),
  supplierInvoiceNo: optionalText(100),
  billDate: date.optional(),
  dueDate: optionalDate,
  notes: optionalText(2000),
  items: items(
    z.object({ ...itemBase, ...priced, orderItemId: idSchema.nullish(), receiptItemId: idSchema.nullish() }),
  ),
});

// ── Payments ───────────────────────────────────────────────────────────────
const allocations = z
  .array(z.object({ billId: idSchema, amount: decimalString({ scale: 4 }) }))
  .max(200)
  .default([]);

export const paymentSchema = z.object({
  supplierId: idSchema,
  paymentMethodId: idSchema,
  paymentDate: date.optional(),
  amount: decimalString({ scale: 4 }),
  reference: optionalText(100),
  notes: optionalText(2000),
  /** Bills to settle; anything left stays as an advance. */
  allocations,
});

export const voidSchema = z.object({ reason: z.string().trim().min(1, 'Enter a reason').max(500) });

export const applyCreditSchema = z.object({
  sourceType: z.enum(['payment', 'debit_note']),
  sourceId: idSchema,
  allocations: allocations.refine((a) => a.length > 0, 'Choose at least one bill'),
});

// ── Returns / debit notes ──────────────────────────────────────────────────
export const returnSchema = z.object({
  type: z.enum(RETURN_TYPES),
  supplierId: idSchema,
  warehouseId: idSchema.nullish(),
  receiptId: idSchema.nullish(),
  billId: idSchema.nullish(),
  returnDate: date.optional(),
  reason: optionalText(255),
  notes: optionalText(2000),
  items: items(
    z.object({
      ...itemBase,
      ...priced,
      receiptItemId: idSchema.nullish(),
      billItemId: idSchema.nullish(),
      batchId: idSchema.nullish(),
      serialNumbers: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
    }),
  ),
});

// ── Shared ─────────────────────────────────────────────────────────────────
export const rejectSchema = z.object({ reason: z.string().trim().min(1, 'Enter a reason').max(500) });

export const listQuery = z
  .object({
    status: z.string().optional(),
    supplierId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    orderId: idSchema.optional(),
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
    basis: z.enum(['due_date', 'bill_date']).default('due_date'),
    supplierId: idSchema.optional(),
  })
  .passthrough();
export const supplierParams = z.object({ supplierId: idSchema });
