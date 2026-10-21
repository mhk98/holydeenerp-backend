import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, Party } from '../../models.js';
import { payablesAging } from '../purchase/payables.service.js';
import { receivablesAging } from '../sales/receivables.service.js';
import { D, accountMap, ensureLedger, fixed } from './ledger.service.js';

/**
 * Ledger health check: the general ledger against the sub-ledgers it summarises.
 *   · trial balance — posted debits equal credits
 *   · receivables / payables — control account per party vs. the document-based balances
 *     (Sales / Purchase keep computing those from documents)
 *   · inventory — inventory account vs. stock valuation; transit account vs. transfers on the road
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const FAR_FUTURE = '9999-12-31';

/** Posted balance (debit − credit) of one account, per party. */
async function partyBalances(companyId, accountId) {
  const rows = await select(
    `SELECT l.party_id AS partyId, SUM(l.debit) - SUM(l.credit) AS balance
       FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE l.company_id = :companyId AND l.account_id = :accountId AND j.status = 'posted' AND j.deleted_at IS NULL
      GROUP BY l.party_id`,
    { companyId, accountId },
  );
  return new Map(rows.map((r) => [String(r.partyId ?? ''), D(r.balance)]));
}

async function accountBalance(companyId, accountId) {
  const [row] = await select(
    `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance
       FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE l.company_id = :companyId AND l.account_id = :accountId AND j.status = 'posted' AND j.deleted_at IS NULL`,
    { companyId, accountId },
  );
  return D(row.balance);
}

/** Compare a control account with document balances (sign: +1 debit-normal, −1 credit-normal). */
async function compareParties(companyId, accountId, documentRows, sign) {
  const ledger = await partyBalances(companyId, accountId);
  const documents = new Map(documentRows.map((r) => [String(r.id), D(r.total)]));
  const ids = new Set([...ledger.keys(), ...documents.keys()]);
  const mismatches = [];
  let ledgerTotal = D(0);
  let documentTotal = D(0);
  for (const id of ids) {
    const gl = (ledger.get(id) ?? D(0)).times(sign);
    const doc = documents.get(id) ?? D(0);
    ledgerTotal = ledgerTotal.plus(gl);
    documentTotal = documentTotal.plus(doc);
    if (!gl.minus(doc).abs().lt('0.01')) mismatches.push({ partyId: id || null, ledger: gl, documents: doc });
  }
  const names = mismatches.length
    ? new Map(
        (
          await Party.findAll({
            where: { id: mismatches.map((m) => m.partyId).filter(Boolean) },
            attributes: ['id', 'code', 'name'],
            paranoid: false,
          })
        ).map((p) => [String(p.id), p]),
      )
    : new Map();
  return {
    ledger: fixed(ledgerTotal),
    documents: fixed(documentTotal),
    difference: fixed(ledgerTotal.minus(documentTotal)),
    balanced: ledgerTotal.minus(documentTotal).abs().lt('0.01'),
    mismatches: mismatches.slice(0, 50).map((m) => ({
      partyId: m.partyId,
      code: names.get(m.partyId)?.code ?? null,
      name: names.get(m.partyId)?.name ?? null,
      ledger: fixed(m.ledger),
      documents: fixed(m.documents),
      difference: fixed(m.ledger.minus(m.documents)),
    })),
  };
}

export async function reconciliation(ctx) {
  const companyId = ctx.auth.companyId;
  await sequelize.transaction((t) => ensureLedger(companyId, t));
  const map = await sequelize.transaction((t) => accountMap(companyId, t));
  // Every branch of the company: the ledger is company-wide.
  const branchIds = (await Branch.findAll({ where: { companyId }, attributes: ['id'], paranoid: false })).map(
    (b) => String(b.id),
  );
  const all = { ...ctx, branchIds, branchId: null };

  const [[totals], [unbalanced], receivables, payables, [stock], [transit]] = await Promise.all([
    select(
      `SELECT COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
         FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
        WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL`,
      { companyId },
    ),
    select(
      `SELECT COUNT(*) AS count FROM journal_entries
        WHERE company_id = :companyId AND status = 'posted' AND deleted_at IS NULL AND total_debit <> total_credit`,
      { companyId },
    ),
    receivablesAging(all, { asOf: FAR_FUTURE }),
    payablesAging(all, { asOf: FAR_FUTURE }),
    select(
      'SELECT COALESCE(SUM(total_value), 0) AS value FROM stock_balances WHERE company_id = :companyId',
      {
        companyId,
      },
    ),
    select(
      `SELECT COALESCE(SUM(total_value), 0) AS value FROM stock_transfers
        WHERE company_id = :companyId AND status = 'in_transit' AND deleted_at IS NULL`,
      { companyId },
    ),
  ]);

  const [ar, ap, inventoryGl, transitGl] = await Promise.all([
    compareParties(
      companyId,
      map.get('ar'),
      receivables.rows.map((r) => ({ id: r.customerId, total: r.total })),
      1,
    ),
    compareParties(
      companyId,
      map.get('ap'),
      payables.rows.map((r) => ({ id: r.supplierId, total: r.total })),
      -1,
    ),
    accountBalance(companyId, map.get('inventory')),
    accountBalance(companyId, map.get('stockInTransit')),
  ]);
  const compare = (ledger, other) => ({
    ledger: fixed(ledger),
    documents: fixed(other),
    difference: fixed(D(ledger).minus(other)),
    balanced: D(ledger).minus(other).abs().lt('0.01'),
  });
  const trial = compare(totals.debit, totals.credit);

  const checks = {
    trialBalance: { debit: fixed(totals.debit), credit: fixed(totals.credit), balanced: trial.balanced },
    unbalancedJournals: Number(unbalanced.count),
    receivables: ar,
    payables: ap,
    inventory: compare(inventoryGl, stock.value),
    inTransit: compare(transitGl, transit.value),
  };
  return {
    ...checks,
    ok:
      checks.trialBalance.balanced &&
      !checks.unbalancedJournals &&
      ar.balanced &&
      ap.balanced &&
      checks.inventory.balanced &&
      checks.inTransit.balanced,
  };
}
