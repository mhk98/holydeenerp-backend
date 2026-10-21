import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, Company, DocumentSequence } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

/** Document types that get numbered. Extend when a module adds a new document. */
export const DOC_TYPES = [
  'sales_invoice',
  'pos_sale',
  'quotation',
  'sales_order',
  'delivery_note',
  'sales_return',
  'money_receipt',
  'purchase_requisition',
  'purchase_rfq',
  'purchase_order',
  'goods_receipt',
  'purchase_bill',
  'purchase_return',
  'payment_voucher',
  'journal_entry',
  'bank_receipt',
  'bank_payment',
  'contra_voucher',
  'expense',
  'stock_transfer',
  'stock_adjustment',
  'opening_stock',
  'stock_count',
  'production_order',
  // Master-data codes generated when left blank.
  'product_sku',
  'customer_code',
  'supplier_code',
];

/** Year and month in the company's timezone (numbering resets on the local new year). */
function localDateParts(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { year: Number(parts.year), month: parts.month };
}

/**
 * Build a document number. Tokens in prefix/suffix: {BRANCH} {YYYY} {YY} {MM}.
 *   formatNumber({ prefix: 'INV-{BRANCH}-{YYYY}-', padding: 5 }, 1, { branchCode: 'DHK', year: 2026 })
 *   → "INV-DHK-2026-00001"
 */
export function formatNumber(seq, number, { branchCode, year, month }) {
  const fill = (s) =>
    (s ?? '')
      .replaceAll('{BRANCH}', branchCode ?? '')
      .replaceAll('{YYYY}', String(year))
      .replaceAll('{YY}', String(year).slice(-2))
      .replaceAll('{MM}', month ?? '');
  return `${fill(seq.prefix)}${String(number).padStart(seq.padding, '0')}${fill(seq.suffix)}`;
}

async function tokensFor(seq, companyId, branchId, transaction) {
  const [company, branch] = await Promise.all([
    Company.findByPk(companyId, { attributes: ['code', 'timezone'], transaction }),
    branchId ? Branch.findByPk(branchId, { attributes: ['code'], transaction }) : null,
  ]);
  const { year, month } = localDateParts(company?.timezone ?? 'Asia/Dhaka');
  return { branchCode: branch?.code ?? company?.code ?? '', year, month };
}

/** Number the next document would get, accounting for a pending yearly reset. */
function upcoming(seq, year) {
  return seq.resetYearly && seq.currentYear && seq.currentYear !== year ? 1 : seq.nextNumber;
}

/**
 * Take the next number for a document. MUST be called inside the transaction that saves the
 * document: the series row is locked (SELECT … FOR UPDATE) so concurrent saves can't collide,
 * and a rolled-back document gives its number back.
 *
 * Uses the branch's own series, falling back to the company-wide one (branch NULL).
 */
export async function nextNumber({ companyId, docType, branchId = null, transaction }) {
  if (!transaction) throw new Error('nextNumber() must run inside a transaction');
  const seq = await DocumentSequence.findOne({
    where: {
      companyId,
      docType,
      isActive: true,
      branchId: branchId ? { [Op.or]: [branchId, null] } : null,
    },
    // Branch-specific series first.
    order: [[sequelize.literal('branch_id IS NULL'), 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!seq)
    throw AppError.badRequest(`No active number series for "${docType}". Add one in Settings → Numbering.`);

  const tokens = await tokensFor(seq, companyId, branchId ?? seq.branchId, transaction);
  const number = upcoming(seq, tokens.year);
  await seq.update({ nextNumber: number + 1, currentYear: tokens.year }, { transaction });
  return formatNumber(seq, number, tokens);
}

export const sequenceCrud = createCrudService({
  model: DocumentSequence,
  label: 'Number series',
  include: () => [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
  listOptions: {
    sortable: ['docType', 'name', 'createdAt'],
    searchable: ['name', 'prefix', 'docType'],
    filterable: ['docType', 'branchId', 'isActive'],
    defaultSort: 'docType',
  },
  beforeSave: async (ctx, data, existing, t) => {
    const branchId = data.branchId !== undefined ? data.branchId : (existing?.branchId ?? null);
    if (data.branchId) {
      const branch = await Branch.count({
        where: { id: data.branchId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!branch)
        throw AppError.unprocessable('Validation failed', [
          { field: 'branchId', message: 'Branch not found' },
        ]);
    }
    // One series per (document type, branch or company-wide).
    const docType = data.docType ?? existing?.docType;
    const clash = await DocumentSequence.count({
      where: {
        companyId: ctx.auth.companyId,
        docType,
        branchId,
        ...(existing && { id: { [Op.ne]: existing.id } }),
      },
      transaction: t,
    });
    if (clash) {
      throw AppError.conflict('A series for this document type and branch already exists', [
        { field: 'docType', message: 'Already defined for this branch' },
      ]);
    }
    return data;
  },
});

/** Preview the next number of a series without consuming it. */
export async function previewSequence(ctx, id) {
  const seq = await sequenceCrud.find(ctx, id);
  const tokens = await tokensFor(seq, ctx.auth.companyId, seq.branchId);
  const number = upcoming(seq, tokens.year);
  return { next: formatNumber(seq, number, tokens), number };
}

/** Preview arbitrary (unsaved) settings — used by the form while typing. */
export async function previewDraft(ctx, draft) {
  const tokens = await tokensFor(draft, ctx.auth.companyId, draft.branchId ?? null);
  return { next: formatNumber(draft, draft.nextNumber ?? 1, tokens) };
}
