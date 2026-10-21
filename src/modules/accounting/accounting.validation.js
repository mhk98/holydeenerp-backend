import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES, JOURNAL_STATUSES } from './accounting.model.js';
import { MAPPING_KEYS } from './chart.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const amount = decimalString({ allowZero: true, scale: 4 });
const SUBTYPES = [...new Set(Object.values(ACCOUNT_SUBTYPES).flat())];

const accountCode = z
  .string({ error: 'Code is required' })
  .trim()
  .min(1, 'Code is required')
  .max(20)
  .regex(/^[A-Za-z0-9.-]+$/, 'Use letters, numbers, dot or dash');

export const accountSchema = z.object({
  code: accountCode,
  name: name(150),
  nameBn: optionalText(150),
  parentId: idSchema.nullish(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  subtype: z.enum(SUBTYPES).optional(),
  isGroup: z.boolean().optional(),
  isActive: z.boolean().optional(),
  description: optionalText(500),
});
export const accountUpdateSchema = accountSchema.partial();

export const accountListQuery = z
  .object({
    type: z.enum(ACCOUNT_TYPES).optional(),
    subtype: z.string().optional(),
    isGroup: boolFilter,
    isActive: boolFilter,
    parentId: idSchema.optional(),
  })
  .passthrough();

export const treeQuery = z
  .object({ balances: boolFilter, asOf: date.optional(), includeInactive: boolFilter })
  .passthrough();

const journalLine = z
  .object({
    accountId: idSchema,
    debit: amount.default('0'),
    credit: amount.default('0'),
    partyId: idSchema.nullish(),
    branchId: idSchema.nullish(),
    description: optionalText(255),
  })
  .refine((l) => Number(l.debit) > 0 !== Number(l.credit) > 0, {
    message: 'Enter either a debit or a credit',
    path: ['debit'],
  });

export const journalSchema = z.object({
  entryDate: date,
  branchId: idSchema.nullish(),
  reference: optionalText(100),
  narration: optionalText(500),
  lines: z.array(journalLine).min(2, 'A journal needs at least two lines').max(500),
  /** Post right away instead of saving a draft. */
  post: z.boolean().optional(),
});

export const reverseSchema = z.object({
  date: date.optional(),
  narration: optionalText(500),
});

export const journalListQuery = z
  .object({
    status: z.enum(JOURNAL_STATUSES).optional(),
    entryType: z.string().optional(),
    sourceType: z.string().optional(),
    sourceId: idSchema.optional(),
    accountId: idSchema.optional(),
    partyId: idSchema.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .passthrough();

export const sourceParams = z.object({ sourceType: z.string().regex(/^[a-z_]+$/), sourceId: idSchema });

export const openingBalancesSchema = z.object({
  date,
  lines: z
    .array(
      z
        .object({ accountId: idSchema, debit: amount.default('0'), credit: amount.default('0') })
        .refine((l) => !(Number(l.debit) > 0 && Number(l.credit) > 0), {
          message: 'Enter either a debit or a credit',
          path: ['debit'],
        }),
    )
    .max(1000),
});

export const fiscalYearSchema = z
  .object({
    name: name(60).optional(),
    startDate: date,
    endDate: date.optional(),
  })
  .refine((v) => !v.endDate || v.endDate > v.startDate, {
    message: 'The year must end after it starts',
    path: ['endDate'],
  });

export const periodStatusSchema = z.object({ status: z.enum(['open', 'locked']) });

export const mappingSchema = z.object({
  accounts: z.partialRecord(z.enum(MAPPING_KEYS), idSchema.nullable()).optional(),
  /** Payment method id → ledger account (null = default for its type). */
  paymentMethods: z.record(z.string().regex(/^\d+$/), idSchema.nullable()).optional(),
});

/** Financial reports: a period (or as-of date), a branch, a comparison and (general ledger) accounts. */
export const reportQuery = z
  .object({
    from: date.optional(),
    to: date.optional(),
    asOf: date.optional(),
    branchId: idSchema.optional(),
    compareFrom: date.optional(),
    compareTo: date.optional(),
    compareAsOf: date.optional(),
    accountId: z
      .string()
      .regex(/^\d+(,\d+)*$/, 'Choose an account')
      .optional(),
    sourceType: z
      .string()
      .regex(/^[a-z_]+$/)
      .optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((q) => !(q.compareFrom || q.compareTo) || (q.compareFrom && q.compareTo), {
    message: 'Give both comparison dates',
    path: ['compareTo'],
  });
