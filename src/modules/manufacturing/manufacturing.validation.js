import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { BOM_STATUSES, MO_STATUSES, PRIORITIES } from './manufacturing.model.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const qty = decimalString({ scale: 4 });
const zeroOrMore = decimalString({ allowZero: true, scale: 4 });
const minutes = decimalString({ allowZero: true, scale: 2, max: 999999 });
const percent = decimalString({ allowZero: true, scale: 4, max: 100 });

// ── Work centers ──────────────────────────────────────────────────────────
export const workCenterSchema = z.object({
  code: code(30),
  name: name(150),
  branchId: idSchema.nullish(),
  capacityHours: decimalString({ scale: 2, max: 24 }).optional(),
  labourCostPerHour: zeroOrMore.optional(),
  overheadCostPerHour: zeroOrMore.optional(),
  isActive: z.boolean().optional(),
  notes: optionalText(500),
});
export const workCenterUpdateSchema = workCenterSchema.partial();
export const workCenterListQuery = z
  .object({ isActive: boolFilter, branchId: idSchema.optional() })
  .passthrough();

// ── Bills of materials ────────────────────────────────────────────────────
const component = z.object({
  productId: idSchema,
  variantId: idSchema.nullish(),
  unitId: idSchema.nullish(),
  quantity: qty,
  wastagePercent: percent.optional(),
  notes: optionalText(255),
});
const byproduct = z.object({
  productId: idSchema,
  variantId: idSchema.nullish(),
  quantity: qty,
  costSharePercent: percent.optional(),
});
const operation = z.object({
  sequence: z.coerce.number().int().min(0).max(9999).optional(),
  name: name(150),
  workCenterId: idSchema,
  setupMinutes: minutes.optional(),
  runMinutes: minutes.optional(),
  notes: optionalText(255),
});
const checkpoint = z.object({ name: name(150), instructions: optionalText(500) });

export const bomSchema = z.object({
  code: code(40),
  name: name(150),
  productId: idSchema,
  variantId: idSchema.nullish(),
  /** Output quantity (base unit) the components make. */
  quantity: qty,
  notes: optionalText(2000),
  items: z.array(component).min(1, 'Add at least one component').max(300),
  byproducts: z.array(byproduct).max(50).optional(),
  operations: z.array(operation).max(100).optional(),
  qualityChecks: z.array(checkpoint).max(50).optional(),
});
/** The BOM form always sends the whole BOM. */
export const bomUpdateSchema = bomSchema;
export const bomListQuery = z
  .object({ status: z.enum(BOM_STATUSES).optional(), productId: idSchema.optional(), isDefault: boolFilter })
  .passthrough();
export const activateBomSchema = z.object({ makeDefault: z.boolean().optional() }).default({});
export const treeQuery = z.object({ quantity: qty.optional() }).passthrough();

// ── Manufacturing orders ──────────────────────────────────────────────────
export const orderSchema = z.object({
  productId: idSchema,
  variantId: idSchema.nullish(),
  bomId: idSchema.nullish(),
  quantity: qty,
  rawWarehouseId: idSchema,
  finishedWarehouseId: idSchema.nullish(),
  priority: z.enum(PRIORITIES).optional(),
  plannedStart: date.optional(),
  plannedEnd: date.optional(),
  salesOrderItemId: idSchema.nullish(),
  parentId: idSchema.nullish(),
  notes: optionalText(2000),
});
export const orderListQuery = z
  .object({
    status: z.enum(MO_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    productId: idSchema.optional(),
    salesOrderId: idSchema.optional(),
    bomId: idSchema.optional(),
    active: boolFilter,
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();
export const rescheduleSchema = z
  .object({
    plannedStart: date.optional(),
    plannedEnd: date.optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .refine((v) => v.plannedStart || v.plannedEnd || v.priority, 'Nothing to change');
export const issueSchema = z
  .object({
    date: date.optional(),
    /** Without lines: everything still to issue. */
    lines: z
      .array(z.object({ materialId: idSchema, quantity: qty, batchId: idSchema.nullish() }))
      .max(300)
      .optional(),
  })
  .default({});
export const returnSchema = z.object({
  date: date.optional(),
  lines: z
    .array(z.object({ materialId: idSchema, quantity: qty, batchId: idSchema.nullish() }))
    .min(1)
    .max(300),
});
export const operationParams = z.object({ id: idSchema, opId: idSchema });
export const finishOperationSchema = z.object({ actualMinutes: minutes });
export const submitSchema = z.object({ producedQuantity: qty });
export const qualitySchema = z
  .object({
    name: name(150),
    result: z.enum(['pass', 'fail']),
    failedQuantity: zeroOrMore.optional(),
    /** For a fail: scrap the failed units or send them back for rework. */
    action: z.enum(['scrap', 'rework']).optional(),
    reason: optionalText(500),
  })
  .refine((v) => v.result === 'pass' || v.action, { path: ['action'], message: 'Choose scrap or rework' });
export const scrapSchema = z.object({
  productId: idSchema,
  variantId: idSchema.nullish(),
  quantity: qty,
  reason: name(255),
});
export const completeSchema = z
  .object({ outputDate: date.optional(), batchNo: optionalText(60), expiryDate: date.nullish() })
  .default({});
export const fromSalesOrderSchema = z.object({
  salesOrderId: idSchema,
  rawWarehouseId: idSchema.optional(),
  finishedWarehouseId: idSchema.optional(),
  plannedStart: date.optional(),
});

// ── Planning, schedule and reports ────────────────────────────────────────
const shortageLine = z.object({ productId: idSchema, variantId: idSchema.nullish(), quantity: qty });
export const mrpQuery = z
  .object({ warehouseId: idSchema.optional(), to: date.optional(), orderId: idSchema.optional() })
  .passthrough();
export const mrpRequisitionSchema = z.object({
  warehouseId: idSchema.nullish(),
  requiredBy: date.nullish(),
  lines: z.array(shortageLine).min(1, 'Choose at least one item').max(300),
});
export const subAssemblySchema = z.object({
  rawWarehouseId: idSchema.optional(),
  parentId: idSchema.optional(),
  plannedStart: date.optional(),
  lines: z.array(shortageLine).min(1, 'Choose at least one item').max(100),
});
export const scheduleQuery = z
  .object({ from: date, to: date, workCenterId: idSchema.optional() })
  .refine((q) => q.from <= q.to, { path: ['to'], message: 'The end is before the start' });
export const reportParams = z.object({
  name: z.enum(['production', 'consumption', 'wastage', 'cost-variance', 'work-centers']),
});
export const reportQuery = z.object({ from: date.optional(), to: date.optional() }).passthrough();
