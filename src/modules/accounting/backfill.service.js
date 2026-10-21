import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { StockMovement } from '../../models.js';
import { accountMap, ensureLedger } from './ledger.service.js';
import { postSource, postStockJournal } from './posting.service.js';

/**
 * Post the journals of documents recorded before accounting existed (or by seeders that write
 * documents directly). Uses the same posting rules as live postings and is idempotent: documents
 * that already have their journal are skipped, so it can run any number of times. Period locks are
 * ignored — this rebuilds history.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** [sourceType, event, SQL selecting `id` of documents to post, ordered by date]. */
const DOCUMENTS = [
  [
    'party',
    'opening',
    `SELECT id FROM parties WHERE company_id = :companyId AND deleted_at IS NULL AND opening_balance <> 0
        AND (is_customer = 1 OR is_supplier = 1) ORDER BY id`,
  ],
  [
    'sales_invoice',
    'post',
    `SELECT id FROM sales_invoices WHERE company_id = :companyId AND deleted_at IS NULL
        AND status IN ('unpaid', 'partially_paid', 'paid') ORDER BY invoice_date, id`,
  ],
  [
    'sales_return',
    'post',
    `SELECT id FROM sales_returns WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY return_date, id`,
  ],
  [
    'sales_return',
    'refund',
    `SELECT id FROM sales_returns WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
        AND refunded_amount > 0 ORDER BY return_date, id`,
  ],
  [
    'customer_receipt',
    'post',
    `SELECT id FROM customer_receipts WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY receipt_date, id`,
  ],
  [
    'supplier_bill',
    'post',
    `SELECT id FROM supplier_bills WHERE company_id = :companyId AND deleted_at IS NULL
        AND status IN ('unpaid', 'partially_paid', 'paid') ORDER BY bill_date, id`,
  ],
  [
    'supplier_payment',
    'post',
    `SELECT id FROM supplier_payments WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY payment_date, id`,
  ],
  [
    'purchase_return',
    'post',
    `SELECT id FROM purchase_returns WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY return_date, id`,
  ],
  [
    'voucher',
    'post',
    `SELECT id FROM vouchers WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY voucher_date, id`,
  ],
  [
    'expense',
    'post',
    `SELECT id FROM expenses WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'posted'
      ORDER BY expense_date, id`,
  ],
  [
    'cheque',
    'clear',
    `SELECT id FROM cheques WHERE company_id = :companyId AND deleted_at IS NULL AND direction = 'received'
        AND status = 'cleared' ORDER BY cleared_at, id`,
  ],
  [
    'pos_session',
    'variance',
    `SELECT id FROM pos_sessions WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'closed'
        AND variance <> 0 ORDER BY closed_at, id`,
  ],
];

/** Stock movement groups (one journal per document and movement type) still without a journal. */
const STOCK_GROUPS = `
  SELECT m.reference_type AS referenceType, m.reference_id AS referenceId, MAX(m.reference_no) AS referenceNo,
         m.movement_type AS movementType, MIN(m.movement_date) AS date, MIN(m.id) AS firstId
    FROM stock_movements m
   WHERE m.company_id = :companyId
     AND NOT EXISTS (
       SELECT 1 FROM journal_entries j
        WHERE j.company_id = m.company_id AND j.source_type = m.reference_type AND j.source_id = m.reference_id
          AND j.event = CONCAT('stock:', m.movement_type) AND j.status = 'posted' AND j.deleted_at IS NULL)
   GROUP BY m.reference_type, m.reference_id, m.movement_type
   ORDER BY date, firstId`;

const BATCH = 50;

/** Backfill one company. Returns { posted: { 'sales_invoice.post': n, … } }. */
export async function backfillCompany(companyId, { userId = null, onProgress } = {}) {
  const posted = {};
  const count = (key, entry) => {
    if (entry) posted[key] = (posted[key] ?? 0) + 1;
  };
  const map = await sequelize.transaction(async (t) => {
    await ensureLedger(companyId, t);
    return accountMap(companyId, t);
  });

  // Stock valuation first (opening stock, receipts, deliveries, …), in batches of documents.
  const groups = await select(STOCK_GROUPS, { companyId });
  for (let i = 0; i < groups.length; i += BATCH) {
    await sequelize.transaction(async (t) => {
      for (const g of groups.slice(i, i + BATCH)) {
        const movements = await StockMovement.findAll({
          where: {
            companyId,
            referenceType: g.referenceType,
            referenceId: g.referenceId,
            movementType: g.movementType,
          },
          order: [['id', 'ASC']],
          transaction: t,
        });
        const entries = await postStockJournal({
          companyId,
          userId,
          date: g.date,
          reference: { type: g.referenceType, id: g.referenceId, no: g.referenceNo },
          movements,
          checkPeriod: false,
          accounts: map,
          transaction: t,
        });
        for (const entry of entries) count('stock', entry);
      }
    });
    onProgress?.(`stock ${Math.min(i + BATCH, groups.length)}/${groups.length}`);
  }

  for (const [sourceType, event, sql] of DOCUMENTS) {
    const ids = (await select(sql, { companyId })).map((r) => String(r.id));
    const key = `${sourceType}.${event}`;
    for (let i = 0; i < ids.length; i += BATCH) {
      await sequelize.transaction(async (t) => {
        for (const id of ids.slice(i, i + BATCH)) {
          const already = await select(
            `SELECT 1 FROM journal_entries WHERE company_id = :companyId AND source_type = :sourceType
                AND source_id = :id AND event = :event AND deleted_at IS NULL LIMIT 1`,
            { companyId, sourceType, id, event },
          );
          if (already.length) continue;
          count(
            key,
            await postSource(sourceType, id, {
              companyId,
              userId,
              event,
              checkPeriod: false,
              accounts: map,
              transaction: t,
            }),
          );
        }
      });
      if (ids.length) onProgress?.(`${key} ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    }
  }
  return { posted };
}
