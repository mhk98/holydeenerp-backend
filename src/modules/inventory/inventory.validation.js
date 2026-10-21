import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, decimalString, optionalText } from '../settings/settings.schemas.js';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_STATUSES,
  COUNT_STATUSES,
  MOVEMENT_TYPES,
  SERIAL_STATUSES,
  TRANSFER_STATUSES,
} from './inventory.model.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalDate = date
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);
const qty = decimalString({ scale: 4 });
const cost = decimalString({ allowZero: true, scale: 4 });
const serials = z.array(z.string().trim().min(1).max(100)).max(1000).optional();
const notes = optionalText(500);

const baseLine = {
  productId: idSchema,
  variantId: idSchema.nullish(),
  batchId: idSchema.nullish(),
  unitId: idSchema.nullish(),
  quantity: qty,
  serialNumbers: serials,
  notes,
};

// ── Adjustments ────────────────────────────────────────────────────────────
const adjustmentLine = z.object({
  ...baseLine,
  direction: z.enum(['in', 'out']).optional(),
  /** New batch for stock-in lines (instead of batchId). */
  batchNo: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => v || null),
  expiryDate: optionalDate,
  mfgDate: optionalDate,
  /** Per base unit. Blank for stock-in = current average cost (or the product's purchase price). */
  unitCost: cost.nullish().or(z.literal('').transform(() => null)),
  reason: z.enum(ADJUSTMENT_REASONS).nullish(),
});

export const adjustmentSchema = z.object({
  kind: z.enum(ADJUSTMENT_KINDS),
  warehouseId: idSchema,
  adjustmentDate: date.optional(),
  reason: z.enum(ADJUSTMENT_REASONS).nullish(),
  notes: optionalText(2000),
  items: z.array(adjustmentLine).min(1, 'Add at least one item').max(500),
});

export const listAdjustmentQuery = z
  .object({
    kind: z.enum(ADJUSTMENT_KINDS).optional(),
    status: z.string().optional(),
    warehouseId: idSchema.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

export const rejectSchema = z.object({ reason: z.string().trim().min(1, 'Enter a reason').max(500) });

// ── Transfers ──────────────────────────────────────────────────────────────
export const transferSchema = z
  .object({
    fromWarehouseId: idSchema,
    toWarehouseId: idSchema,
    transferDate: date.optional(),
    notes: optionalText(2000),
    items: z.array(z.object(baseLine)).min(1, 'Add at least one item').max(500),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: 'Choose a different destination warehouse',
    path: ['toWarehouseId'],
  });

export const listTransferQuery = z
  .object({
    status: z.string().optional(),
    fromWarehouseId: idSchema.optional(),
    toWarehouseId: idSchema.optional(),
    direction: z.enum(['outgoing', 'incoming']).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

// ── Counts ─────────────────────────────────────────────────────────────────
export const countSchema = z.object({
  warehouseId: idSchema,
  countDate: date.optional(),
  categoryId: idSchema.nullish(),
  includeZero: z.boolean().optional(),
  notes: optionalText(2000),
});

export const countEntriesSchema = z.object({
  items: z
    .array(
      z.object({
        id: idSchema,
        countedQuantity: decimalString({ allowZero: true, scale: 4 })
          .nullish()
          .or(z.literal('').transform(() => null)),
        notes,
      }),
    )
    .min(1)
    .max(5000),
});

export const listCountQuery = z
  .object({ status: z.string().optional(), warehouseId: idSchema.optional() })
  .passthrough();

// ── Queries ────────────────────────────────────────────────────────────────
export const STOCK_STATUSES = ['in_stock', 'low', 'out', 'negative'];

export const stockQuery = z
  .object({
    warehouseId: idSchema.optional(),
    categoryId: idSchema.optional(),
    brandId: idSchema.optional(),
    status: z.enum(STOCK_STATUSES).optional(),
    includeInactive: boolFilter,
  })
  .passthrough();

export const stockCardQuery = z
  .object({
    variantId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

export const movementsQuery = z
  .object({
    warehouseId: idSchema.optional(),
    productId: idSchema.optional(),
    variantId: idSchema.optional(),
    movementType: z.enum(MOVEMENT_TYPES).optional(),
    referenceType: z.string().max(40).optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

export const itemSearchQuery = z.object({
  q: z.string().trim().max(100).default(''),
  warehouseId: idSchema.optional(),
  /** true = barcode/SKU scan: exact matches only. */
  exact: boolFilter,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const batchesQuery = z.object({
  productId: idSchema,
  variantId: idSchema.optional(),
  warehouseId: idSchema.optional(),
  available: boolFilter,
});

export const serialsQuery = z
  .object({
    productId: idSchema.optional(),
    variantId: idSchema.optional(),
    warehouseId: idSchema.optional(),
    batchId: idSchema.optional(),
    status: z.enum(SERIAL_STATUSES).optional(),
  })
  .passthrough();

export const productParams = z.object({ productId: idSchema });

export const alertsQuery = z.object({
  warehouseId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const reportQuery = z
  .object({
    warehouseId: idSchema.optional(),
    categoryId: idSchema.optional(),
    groupBy: z.enum(['item', 'category', 'warehouse']).optional(),
    from: date.optional(),
    to: date.optional(),
    basis: z.enum(['consumption', 'stock_value']).optional(),
    status: z.enum(['expired', 'near', 'ok', 'all']).optional(),
    days: z.coerce.number().int().min(1).max(1825).optional(),
    class: z.enum(['slow', 'dead', 'all']).optional(),
  })
  .passthrough();

export { ADJUSTMENT_STATUSES, COUNT_STATUSES, TRANSFER_STATUSES };
