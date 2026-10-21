import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { FiscalPeriod, FiscalYear, JournalEntry, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { invalid } from '../inventory/inventory.common.js';
import { addDays } from '../purchase/purchase.common.js';
import { D, forgetLedgerCache, postJournal, reverseJournal } from './ledger.service.js';

/**
 * Fiscal years split into monthly periods. A locked period refuses every posting dated in it
 * (documents included). Closing a year locks all its periods and posts the closing entry that
 * moves the year's profit or loss into retained earnings; reopening reverses that entry.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const lastOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);

/** Monthly periods covering [start, end]. */
export function monthlyPeriods(start, end) {
  const periods = [];
  let cursor = start;
  while (cursor <= end) {
    const [y, m] = cursor.split('-').map(Number);
    const monthEnd = lastOfMonth(y, m - 1);
    const periodEnd = monthEnd < end ? monthEnd : end;
    periods.push({ name: `${MONTHS[m - 1]} ${y}`, startDate: cursor, endDate: periodEnd });
    cursor = addDays(periodEnd, 1);
  }
  return periods;
}

const include = () => [
  {
    model: FiscalPeriod,
    as: 'periods',
    separate: true,
    order: [['startDate', 'ASC']],
    include: [{ model: User, as: 'locker', attributes: ['id', 'name'] }],
  },
  { model: User, as: 'closer', attributes: ['id', 'name'] },
];

export async function listFiscalYears(ctx) {
  const rows = await FiscalYear.findAll({
    where: { companyId: ctx.auth.companyId },
    include: include(),
    order: [['startDate', 'DESC']],
  });
  return rows.map((r) => r.toJSON());
}

async function findYear(ctx, id, t, lock = false) {
  const year = await FiscalYear.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    ...(lock && { lock: t.LOCK.UPDATE }),
  });
  if (!year) throw AppError.notFound('Fiscal year not found');
  return year;
}

export async function getFiscalYear(ctx, id) {
  const year = await FiscalYear.findOne({ where: { id, companyId: ctx.auth.companyId }, include: include() });
  if (!year) throw AppError.notFound('Fiscal year not found');
  return year.toJSON();
}

export async function createFiscalYear(ctx, input) {
  const startDate = input.startDate;
  const [y, m, d] = startDate.split('-').map(Number);
  const endDate =
    input.endDate ?? addDays(new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10), -1);
  if (endDate > addDays(startDate, 550)) throw invalid('endDate', 'A fiscal year can be at most 18 months');
  const endYear = Number(endDate.slice(0, 4));
  const name = input.name ?? (endYear === y ? `FY ${y}` : `FY ${y}-${String(endYear).slice(-2)}`);

  const id = await sequelize.transaction(async (t) => {
    const overlap = await FiscalYear.findOne({
      where: {
        companyId: ctx.auth.companyId,
        startDate: { [Op.lte]: endDate },
        endDate: { [Op.gte]: startDate },
      },
      transaction: t,
    });
    if (overlap)
      throw invalid('startDate', `Overlaps ${overlap.name} (${overlap.startDate} – ${overlap.endDate})`);
    if (await FiscalYear.count({ where: { companyId: ctx.auth.companyId, name }, transaction: t }))
      throw invalid('name', 'A fiscal year with this name exists');
    const audit = { companyId: ctx.auth.companyId, createdBy: ctx.auth.userId, updatedBy: ctx.auth.userId };
    const year = await FiscalYear.create({ ...audit, name, startDate, endDate }, { transaction: t });
    await FiscalPeriod.bulkCreate(
      monthlyPeriods(startDate, endDate).map((p) => ({ ...audit, ...p, fiscalYearId: year.id })),
      { transaction: t },
    );
    return year.id;
  });
  return getFiscalYear(ctx, id);
}

export async function deleteFiscalYear(ctx, id) {
  await sequelize.transaction(async (t) => {
    const year = await findYear(ctx, id, t, true);
    if (year.status === 'closed') throw AppError.conflict('Reopen the year before deleting it');
    if (await FiscalPeriod.count({ where: { fiscalYearId: year.id, status: 'locked' }, transaction: t }))
      throw AppError.conflict('Unlock its periods before deleting the year');
    await FiscalPeriod.destroy({ where: { fiscalYearId: year.id }, transaction: t });
    await year.destroy({ transaction: t });
  });
}

export async function setPeriodStatus(ctx, periodId, status) {
  await sequelize.transaction(async (t) => {
    const period = await FiscalPeriod.findOne({
      where: { id: periodId, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!period) throw AppError.notFound('Period not found');
    const year = await findYear(ctx, period.fiscalYearId, t);
    if (status === 'open' && year.status === 'closed')
      throw AppError.conflict(`${year.name} is closed; reopen the year first`);
    if (status === 'locked') {
      const drafts = await JournalEntry.count({
        where: {
          companyId: ctx.auth.companyId,
          status: 'draft',
          entryDate: { [Op.between]: [period.startDate, period.endDate] },
        },
        transaction: t,
      });
      if (drafts)
        throw AppError.conflict(`Post or delete the ${drafts} draft journal(s) in ${period.name} first`);
    }
    await period.update(
      {
        status,
        lockedBy: status === 'locked' ? ctx.auth.userId : null,
        lockedAt: status === 'locked' ? new Date() : null,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  forgetLedgerCache(ctx.auth.companyId);
}

/** Close: lock every period and move income / expense balances to retained earnings (per branch). */
export async function closeFiscalYear(ctx, id) {
  await sequelize.transaction(async (t) => {
    const year = await findYear(ctx, id, t, true);
    if (year.status === 'closed') throw AppError.conflict(`${year.name} is already closed`);
    const earlier = await FiscalYear.findOne({
      where: { companyId: ctx.auth.companyId, status: 'open', endDate: { [Op.lt]: year.startDate } },
      transaction: t,
    });
    if (earlier) throw AppError.conflict(`Close ${earlier.name} first`);
    const drafts = await JournalEntry.count({
      where: {
        companyId: ctx.auth.companyId,
        status: 'draft',
        entryDate: { [Op.between]: [year.startDate, year.endDate] },
      },
      transaction: t,
    });
    if (drafts) throw AppError.conflict(`Post or delete the ${drafts} draft journal(s) of this year first`);

    const balances = await sequelize.query(
      `SELECT l.account_id AS accountId, l.branch_id AS branchId, SUM(l.debit) - SUM(l.credit) AS balance
         FROM journal_lines l
         JOIN journal_entries j ON j.id = l.journal_id
         JOIN accounts a ON a.id = l.account_id
        WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
          AND j.entry_date BETWEEN :start AND :end AND a.type IN ('income', 'expense')
        GROUP BY l.account_id, l.branch_id
       HAVING balance <> 0`,
      {
        replacements: { companyId: ctx.auth.companyId, start: year.startDate, end: year.endDate },
        type: QueryTypes.SELECT,
        transaction: t,
      },
    );
    const lines = [];
    const byBranch = new Map();
    for (const b of balances) {
      lines.push({ accountId: b.accountId, branchId: b.branchId, amount: D(b.balance).neg() });
      const key = b.branchId ?? '';
      byBranch.set(key, (byBranch.get(key) ?? D(0)).plus(b.balance));
    }
    for (const [branchId, amount] of byBranch)
      lines.push({ key: 'retainedEarnings', branchId: branchId || null, amount });

    const entry = lines.length
      ? await postJournal({
          companyId: ctx.auth.companyId,
          userId: ctx.auth.userId,
          date: year.endDate,
          entryType: 'closing',
          sourceType: 'fiscal_year',
          sourceId: year.id,
          sourceNo: year.name,
          event: 'close',
          narration: `Closing entry — ${year.name}`,
          lines,
          checkPeriod: false,
          transaction: t,
        })
      : null;
    await FiscalPeriod.update(
      { status: 'locked', lockedBy: ctx.auth.userId, lockedAt: new Date(), updatedBy: ctx.auth.userId },
      { where: { fiscalYearId: year.id, status: 'open' }, transaction: t },
    );
    await year.update(
      {
        status: 'closed',
        closingJournalId: entry?.id ?? null,
        closedBy: ctx.auth.userId,
        closedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  forgetLedgerCache(ctx.auth.companyId);
  return getFiscalYear(ctx, id);
}

/** Reopen: reverse the closing entry; the periods stay locked until unlocked one by one. */
export async function reopenFiscalYear(ctx, id) {
  await sequelize.transaction(async (t) => {
    const year = await findYear(ctx, id, t, true);
    if (year.status !== 'closed') throw AppError.conflict(`${year.name} is not closed`);
    const later = await FiscalYear.findOne({
      where: { companyId: ctx.auth.companyId, status: 'closed', startDate: { [Op.gt]: year.endDate } },
      transaction: t,
    });
    if (later) throw AppError.conflict(`Reopen ${later.name} first`);
    if (year.closingJournalId) {
      const entry = await JournalEntry.findByPk(year.closingJournalId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (entry && !entry.reversedById)
        await reverseJournal(entry, {
          userId: ctx.auth.userId,
          date: year.endDate,
          narration: `Reopened ${year.name}`,
          checkPeriod: false,
          transaction: t,
        });
    }
    await year.update(
      { status: 'open', closingJournalId: null, closedBy: null, closedAt: null, updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  forgetLedgerCache(ctx.auth.companyId);
  return getFiscalYear(ctx, id);
}
