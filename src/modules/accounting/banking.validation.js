import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, code, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { MONEY_KINDS, VOUCHER_TYPES } from './banking.model.js';
import { DATE_FORMATS } from './statement-import.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const amount = decimalString({ scale: 4 });
const zeroOrMore = decimalString({ allowZero: true, scale: 4 });
/** Signed amount (a statement balance can be overdrawn). */
const signedAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d{1,4})?$/.test(v), 'Enter a number');

export const bankAccountSchema = z.object({
  kind: z.enum(MONEY_KINDS),
  name: name(150),
  /** Link an existing cash / bank ledger instead of creating one. */
  accountId: idSchema.nullish(),
  branchId: idSchema.nullish(),
  bankName: optionalText(150),
  branchName: optionalText(150),
  accountNumber: optionalText(60),
  routingNumber: optionalText(30),
  isActive: z.boolean().optional(),
  notes: optionalText(500),
});
export const bankAccountUpdateSchema = bankAccountSchema.omit({ accountId: true }).partial();
export const bankAccountListQuery = z
  .object({ kind: z.enum(MONEY_KINDS).optional(), isActive: boolFilter, asOf: date.optional() })
  .passthrough();

export const voucherSchema = z.object({
  voucherType: z.enum(VOUCHER_TYPES),
  voucherDate: date,
  bankAccountId: idSchema,
  toBankAccountId: idSchema.nullish(),
  /** Contra only (receipt / payment amounts come from the lines). */
  amount: zeroOrMore.optional(),
  partyName: optionalText(150),
  reference: optionalText(100),
  narration: optionalText(500),
  lines: z
    .array(z.object({ accountId: idSchema, amount, description: optionalText(255) }))
    .max(200)
    .optional(),
  post: z.boolean().optional(),
});
export const voidSchema = z.object({ reason: z.string().trim().min(1, 'Enter a reason').max(500) });

export const listQuery = z
  .object({
    status: z.string().optional(),
    voucherType: z.enum(VOUCHER_TYPES).optional(),
    bankAccountId: idSchema.optional(),
    categoryId: idSchema.optional(),
    direction: z.enum(['received', 'issued']).optional(),
    partyId: idSchema.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

export const chequeUpdateSchema = z.object({
  chequeNo: z.string().trim().min(1).max(60).optional(),
  bankName: optionalText(150),
  chequeDate: date.optional(),
  notes: optionalText(500),
});
export const chequeActionSchema = z.object({
  bankAccountId: idSchema.optional(),
  date: date.optional(),
});
export const chequeBounceSchema = z.object({
  date: date.optional(),
  reason: z.string().trim().min(1, 'Enter a reason').max(500),
});

export const expenseCategorySchema = z.object({
  name: name(150),
  code: code(),
  accountId: idSchema,
  description: optionalText(500),
  isActive: z.boolean().optional(),
});
export const expenseCategoryUpdateSchema = expenseCategorySchema.partial();

export const expenseSchema = z.object({
  expenseDate: date,
  categoryId: idSchema,
  bankAccountId: idSchema,
  amount,
  taxAmount: zeroOrMore.optional(),
  payee: optionalText(150),
  reference: optionalText(100),
  description: optionalText(500),
  post: z.boolean().optional(),
});

export const reconciliationSchema = z.object({
  bankAccountId: idSchema,
  statementDate: date,
  statementBalance: signedAmount,
  notes: optionalText(500),
});
export const reconciliationUpdateSchema = z.object({
  statementBalance: signedAmount.optional(),
  notes: optionalText(500),
});
export const clearLineSchema = z.object({ journalLineId: idSchema, cleared: z.boolean() });
export const matchSchema = z.object({ statementLineId: idSchema, journalLineId: idSchema });
export const bookLineSchema = z.object({ accountId: idSchema, narration: optionalText(500) });

const column = z.coerce.number().int().min(1).max(100);
/** Sent as a JSON string in the multipart form. */
export const statementMappingSchema = z
  .object({
    headerRow: z.coerce.number().int().min(0).max(50).default(1),
    date: column,
    description: column.optional(),
    reference: column.optional(),
    debit: column.optional(),
    credit: column.optional(),
    amount: column.optional(),
    dateFormat: z.enum(DATE_FORMATS),
  })
  .refine((m) => m.amount || m.debit || m.credit, {
    message: 'Choose the amount column(s)',
    path: ['amount'],
  });

export const statementParams = z.object({ id: idSchema, lineId: idSchema });
export const attachmentParams = z.object({
  entityType: z.enum(['expense', 'voucher']),
  entityId: idSchema,
});
