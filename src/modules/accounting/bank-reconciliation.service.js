import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { BankAccount, BankReconciliation, BankStatementLine, JournalLine, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { invalid } from '../inventory/inventory.common.js';
import { findBankAccount } from './bank-accounts.service.js';
import { D, fixed } from './ledger.service.js';
import { mapStatementRows, readStatementRows } from './statement-import.js';
import { createVoucher } from './vouchers.service.js';

/**
 * Bank reconciliation: tick the ledger lines of a bank account that appear on the bank statement
 * (by hand, or by matching imported statement lines) until
 *   previous statement balance + cleared lines = this statement's balance.
 * Then complete it; the ticked lines stay cleared. Bank charges / interest seen only on the statement
 * become a voucher straight from the statement line.
 */

const select = (sql, replacements, t) =>
  sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });

async function findRec(ctx, id, t, { lock = false, status } = {}) {
  const rec = await BankReconciliation.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    ...(lock && { lock: t.LOCK.UPDATE }),
  });
  if (!rec) throw AppError.notFound('Reconciliation not found');
  if (status && rec.status !== status)
    throw AppError.conflict(
      rec.status === 'completed'
        ? 'This reconciliation is completed'
        : 'This reconciliation is still in progress',
    );
  return rec;
}

export async function listReconciliations(ctx, query = {}) {
  const rows = await BankReconciliation.findAll({
    where: {
      companyId: ctx.auth.companyId,
      ...(query.bankAccountId && { bankAccountId: query.bankAccountId }),
    },
    include: [
      { model: BankAccount, as: 'bankAccount', attributes: ['id', 'name', 'kind'], paranoid: false },
      { model: User, as: 'completer', attributes: ['id', 'name'] },
    ],
    order: [
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 200,
  });
  return rows.map((r) => r.toJSON());
}

export async function createReconciliation(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const bank = await findBankAccount(ctx, input.bankAccountId, 'bankAccountId', t);
    await BankAccount.findByPk(bank.id, { transaction: t, lock: t.LOCK.UPDATE });
    const open = await BankReconciliation.findOne({
      where: { companyId: ctx.auth.companyId, bankAccountId: bank.id, status: 'in_progress' },
      transaction: t,
    });
    if (open)
      throw invalid('bankAccountId', 'Finish the reconciliation already in progress for this account');
    const last = await BankReconciliation.findOne({
      where: { companyId: ctx.auth.companyId, bankAccountId: bank.id, status: 'completed' },
      order: [['statementDate', 'DESC']],
      transaction: t,
    });
    if (last && input.statementDate <= last.statementDate)
      throw invalid('statementDate', `The last reconciliation is dated ${last.statementDate}`);
    const rec = await BankReconciliation.create(
      {
        companyId: ctx.auth.companyId,
        bankAccountId: bank.id,
        statementDate: input.statementDate,
        statementBalance: fixed(input.statementBalance),
        openingBalance: last ? last.statementBalance : '0',
        notes: input.notes ?? null,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    return rec.id;
  });
  return getReconciliation(ctx, id);
}

/** Ledger lines of the bank account up to the statement date: not yet cleared, or cleared here. */
function ledgerLines(rec, bank, t) {
  return select(
    `SELECT l.id, j.id AS journalId, j.number, j.entry_date AS date, j.narration, j.reference, j.source_type AS sourceType,
            j.source_id AS sourceId, j.source_no AS sourceNo, l.description, l.debit - l.credit AS amount,
            l.reconciliation_id AS reconciliationId, l.cleared_date AS clearedDate
       FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE l.company_id = :companyId AND l.account_id = :accountId AND j.status = 'posted' AND j.deleted_at IS NULL
        AND j.entry_date <= :statementDate AND (l.reconciliation_id IS NULL OR l.reconciliation_id = :recId)
      ORDER BY j.entry_date, j.id, l.id`,
    { companyId: rec.companyId, accountId: bank.accountId, statementDate: rec.statementDate, recId: rec.id },
    t,
  );
}

export async function getReconciliation(ctx, id) {
  const rec = await findRec(ctx, id);
  const bank = await BankAccount.findByPk(rec.bankAccountId, { paranoid: false });
  const [statement, ledger, [glBalance]] = await Promise.all([
    BankStatementLine.findAll({ where: { reconciliationId: rec.id }, order: [['sortOrder', 'ASC']] }),
    ledgerLines(rec, bank),
    select(
      `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS balance
         FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
        WHERE l.company_id = :companyId AND l.account_id = :accountId AND j.status = 'posted'
          AND j.deleted_at IS NULL AND j.entry_date <= :statementDate`,
      { companyId: rec.companyId, accountId: bank.accountId, statementDate: rec.statementDate },
    ),
  ]);
  const cleared = ledger.filter((l) => String(l.reconciliationId) === String(rec.id));
  const clearedTotal = cleared.reduce((s, l) => s.plus(l.amount), D(0));
  const clearedBalance = D(rec.openingBalance).plus(clearedTotal);
  const outstanding = ledger.filter((l) => !l.reconciliationId);
  return {
    ...rec.toJSON(),
    bankAccount: {
      id: String(bank.id),
      name: bank.name,
      kind: bank.kind,
      accountId: String(bank.accountId),
      statementMapping: bank.statementMapping,
    },
    statementLines: statement.map((s) => s.toJSON()),
    ledgerLines: ledger.map((l) => ({
      ...l,
      id: String(l.id),
      amount: fixed(l.amount),
      cleared: String(l.reconciliationId) === String(rec.id),
    })),
    summary: {
      openingBalance: fixed(rec.openingBalance),
      clearedDeposits: fixed(
        cleared.filter((l) => D(l.amount).gt(0)).reduce((s, l) => s.plus(l.amount), D(0)),
      ),
      clearedPayments: fixed(
        cleared.filter((l) => D(l.amount).lt(0)).reduce((s, l) => s.plus(l.amount), D(0)),
      ),
      clearedBalance: fixed(clearedBalance),
      statementBalance: fixed(rec.statementBalance),
      difference: fixed(D(rec.statementBalance).minus(clearedBalance)),
      ledgerBalance: fixed(glBalance.balance),
      outstandingDeposits: fixed(
        outstanding.filter((l) => D(l.amount).gt(0)).reduce((s, l) => s.plus(l.amount), D(0)),
      ),
      outstandingPayments: fixed(
        outstanding.filter((l) => D(l.amount).lt(0)).reduce((s, l) => s.plus(l.amount), D(0)),
      ),
    },
  };
}

export async function updateReconciliation(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    await rec.update(
      {
        ...(input.statementBalance != null && { statementBalance: fixed(input.statementBalance) }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getReconciliation(ctx, id);
}

/** A ledger line of this reconciliation's bank account (clearable here). */
async function clearableLine(rec, journalLineId, t) {
  const bank = await BankAccount.findByPk(rec.bankAccountId, { paranoid: false, transaction: t });
  const [line] = (await ledgerLines(rec, bank, t)).filter((l) => String(l.id) === String(journalLineId));
  if (!line) throw invalid('journalLineId', 'This ledger line is not open on this bank account');
  return line;
}

/** Tick / untick a ledger line by hand. */
export async function setLineCleared(ctx, id, { journalLineId, cleared }) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    await clearableLine(rec, journalLineId, t);
    if (!cleared) {
      await BankStatementLine.update(
        { journalLineId: null },
        { where: { reconciliationId: rec.id, journalLineId }, transaction: t },
      );
    }
    await JournalLine.update(
      cleared
        ? { reconciliationId: rec.id, clearedDate: rec.statementDate }
        : { reconciliationId: null, clearedDate: null },
      { where: { id: journalLineId }, transaction: t },
    );
  });
  return getReconciliation(ctx, id);
}

async function matchInTx(rec, statementLineId, journalLineId, t) {
  const statementLine = await BankStatementLine.findOne({
    where: { id: statementLineId, reconciliationId: rec.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!statementLine) throw invalid('statementLineId', 'Statement line not found');
  if (statementLine.journalLineId) throw invalid('statementLineId', 'This statement line is already matched');
  const line = await clearableLine(rec, journalLineId, t);
  if (line.reconciliationId) throw invalid('journalLineId', 'This ledger line is already cleared');
  if (!D(line.amount).eq(statementLine.amount))
    throw invalid(
      'journalLineId',
      `Amounts differ: ledger ${fixed(line.amount)}, statement ${statementLine.amount}`,
    );
  await statementLine.update({ journalLineId }, { transaction: t });
  await JournalLine.update(
    { reconciliationId: rec.id, clearedDate: statementLine.lineDate },
    { where: { id: journalLineId }, transaction: t },
  );
}

export async function matchLines(ctx, id, { statementLineId, journalLineId }) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    await matchInTx(rec, statementLineId, journalLineId, t);
  });
  return getReconciliation(ctx, id);
}

export async function unmatchLine(ctx, id, statementLineId) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    const statementLine = await BankStatementLine.findOne({
      where: { id: statementLineId, reconciliationId: rec.id },
      transaction: t,
    });
    if (!statementLine?.journalLineId) throw invalid('statementLineId', 'This statement line is not matched');
    await JournalLine.update(
      { reconciliationId: null, clearedDate: null },
      { where: { id: statementLine.journalLineId, reconciliationId: rec.id }, transaction: t },
    );
    await statementLine.update({ journalLineId: null }, { transaction: t });
  });
  return getReconciliation(ctx, id);
}

/**
 * Match every unmatched statement line that has exactly one ledger candidate of the same amount:
 * a matching reference first, else the closest date within 10 days.
 */
export async function autoMatch(ctx, id) {
  let matched = 0;
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    const bank = await BankAccount.findByPk(rec.bankAccountId, { paranoid: false, transaction: t });
    const open = (await ledgerLines(rec, bank, t)).filter((l) => !l.reconciliationId);
    const used = new Set();
    const statement = await BankStatementLine.findAll({
      where: { reconciliationId: rec.id, journalLineId: null },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86_400_000;
    for (const s of statement) {
      const candidates = open.filter((l) => !used.has(String(l.id)) && D(l.amount).eq(s.amount));
      if (!candidates.length) continue;
      const ref = (s.reference ?? '').toLowerCase();
      const byRef = ref
        ? candidates.filter((l) =>
            [l.number, l.reference, l.sourceNo].some((v) => v && ref.includes(String(v).toLowerCase())),
          )
        : [];
      const near = candidates
        .filter((l) => days(l.date, s.lineDate) <= 10)
        .sort((a, b) => days(a.date, s.lineDate) - days(b.date, s.lineDate));
      const pick = byRef.length === 1 ? byRef[0] : near[0];
      if (!pick) continue;
      await matchInTx(rec, s.id, pick.id, t);
      used.add(String(pick.id));
      matched += 1;
    }
  });
  return { matched, reconciliation: await getReconciliation(ctx, id) };
}

/** Read a statement file. Without a mapping: a preview (first rows) to choose columns from. */
export async function importStatement(ctx, id, file, mapping) {
  if (!file)
    throw AppError.unprocessable('Choose a statement file', [{ field: 'file', message: 'Choose a file' }]);
  const rows = await readStatementRows(file.buffer, file.originalname);
  const rec = await findRec(ctx, id, null, { status: 'in_progress' });
  const bank = await BankAccount.findByPk(rec.bankAccountId, { paranoid: false });
  if (!mapping) {
    return {
      preview: rows
        .slice(0, 12)
        .map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))),
      columns: Math.max(0, ...rows.slice(0, 12).map((r) => r.length)),
      mapping: bank.statementMapping,
    };
  }
  const { lines, errors } = mapStatementRows(rows, mapping);
  if (!lines.length)
    throw AppError.unprocessable('No transactions were found with this column mapping', [
      {
        field: 'mapping',
        message: errors[0] ? `Row ${errors[0].row}: ${errors[0].message}` : 'Check the columns',
      },
    ]);
  await sequelize.transaction(async (t) => {
    const locked = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    const start = await BankStatementLine.count({ where: { reconciliationId: locked.id }, transaction: t });
    await BankStatementLine.bulkCreate(
      lines.map((l, i) => ({ ...l, reconciliationId: locked.id, sortOrder: start + i })),
      { transaction: t },
    );
    await bank.update({ statementMapping: mapping, updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return { imported: lines.length, skipped: errors, reconciliation: await getReconciliation(ctx, id) };
}

export async function deleteStatementLine(ctx, id, statementLineId) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    const line = await BankStatementLine.findOne({
      where: { id: statementLineId, reconciliationId: rec.id },
      transaction: t,
    });
    if (!line) throw AppError.notFound('Statement line not found');
    if (line.journalLineId) throw AppError.conflict('Unmatch the line first');
    await line.destroy({ transaction: t });
  });
  return getReconciliation(ctx, id);
}

/**
 * Book a statement line the ledger doesn't have yet (bank charges, interest, a direct deposit) as a
 * posted receipt / payment voucher on `accountId`, then match it.
 */
export async function bookStatementLine(ctx, id, statementLineId, { accountId, narration }) {
  const rec = await findRec(ctx, id, null, { status: 'in_progress' });
  const line = await BankStatementLine.findOne({ where: { id: statementLineId, reconciliationId: rec.id } });
  if (!line) throw AppError.notFound('Statement line not found');
  if (line.journalLineId) throw AppError.conflict('This statement line is already matched');
  const amount = D(line.amount);
  const voucher = await createVoucher(ctx, {
    voucherType: amount.gt(0) ? 'receipt' : 'payment',
    voucherDate: line.lineDate,
    bankAccountId: rec.bankAccountId,
    reference: line.reference,
    narration: narration ?? line.description ?? 'Bank statement entry',
    lines: [{ accountId, amount: fixed(amount.abs()), description: line.description }],
    post: true,
  });
  const bank = await BankAccount.findByPk(rec.bankAccountId, { paranoid: false });
  const [journalLine] = await select(
    `SELECT l.id FROM journal_lines l JOIN journal_entries j ON j.id = l.journal_id
      WHERE j.source_type = 'voucher' AND j.source_id = :voucherId AND j.status = 'posted'
        AND j.reversed_by_id IS NULL AND l.account_id = :accountId LIMIT 1`,
    { voucherId: voucher.id, accountId: bank.accountId },
  );
  await sequelize.transaction(async (t) => {
    const locked = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    await matchInTx(locked, line.id, journalLine.id, t);
  });
  return getReconciliation(ctx, id);
}

export async function completeReconciliation(ctx, id) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    const { summary } = await getReconciliation(ctx, rec.id);
    if (!D(summary.difference).isZero())
      throw AppError.conflict(`The reconciliation is out by ${D(summary.difference).toFixed(2)}`);
    await rec.update(
      {
        status: 'completed',
        completedBy: ctx.auth.userId,
        completedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getReconciliation(ctx, id);
}

/** Reopen the latest completed reconciliation of its account. */
export async function reopenReconciliation(ctx, id) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'completed' });
    const later = await BankReconciliation.count({
      where: {
        companyId: rec.companyId,
        bankAccountId: rec.bankAccountId,
        id: { [Op.ne]: rec.id },
        statementDate: { [Op.gt]: rec.statementDate },
      },
      transaction: t,
    });
    if (later) throw AppError.conflict('Only the latest reconciliation of an account can be reopened');
    await rec.update(
      { status: 'in_progress', completedBy: null, completedAt: null, updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getReconciliation(ctx, id);
}

/** Delete an in-progress reconciliation; its ticks are released. */
export async function deleteReconciliation(ctx, id) {
  await sequelize.transaction(async (t) => {
    const rec = await findRec(ctx, id, t, { lock: true, status: 'in_progress' });
    await JournalLine.update(
      { reconciliationId: null, clearedDate: null },
      { where: { reconciliationId: rec.id }, transaction: t },
    );
    await BankStatementLine.destroy({ where: { reconciliationId: rec.id }, transaction: t });
    await rec.destroy({ transaction: t });
  });
}
