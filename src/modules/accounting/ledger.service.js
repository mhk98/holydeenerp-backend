import { Op } from 'sequelize';
import { Account, Company, DocumentSequence, FiscalPeriod, JournalEntry, JournalLine } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../config/logger.js';
import { D, fixed } from '../purchase/purchase.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { getSettings } from '../settings/settings.service.js';
import { METHOD_DEFAULT_KEY, STANDARD_CHART } from './chart.js';

/**
 * The general ledger core. Every journal — manual or automatic — is written by postJournal(), which
 * checks the balance and the period lock and numbers the entry. Automatic postings are idempotent
 * per (source, event) and are undone with reversing entries, never by deleting.
 */

export { D, fixed };

/** Companies whose chart of accounts is known to exist (saves a query per posting). */
const provisioned = new Set();

/** Create the standard chart (level by level so parents exist) and a journal number series. */
export async function provisionLedger(companyId, t, userId = null) {
  const audit = { companyId, createdBy: userId, updatedBy: userId };
  const ids = new Map();
  const depthOf = (row) => {
    let depth = 0;
    let parent = row[5];
    while (parent) {
      depth += 1;
      parent = STANDARD_CHART.find((r) => r[0] === parent)[5];
    }
    return depth;
  };
  const maxDepth = Math.max(...STANDARD_CHART.map(depthOf));
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const rows = STANDARD_CHART.filter((r) => depthOf(r) === depth);
    await Account.bulkCreate(
      rows.map(([code, name, nameBn, type, subtype, parentCode, opts]) => ({
        ...audit,
        code,
        name,
        nameBn,
        type,
        subtype,
        parentId: parentCode ? ids.get(parentCode) : null,
        isGroup: Boolean(opts.group),
        systemKey: opts.key ?? null,
        isSystem: Boolean(opts.group || opts.key),
      })),
      { transaction: t },
    );
    const created = await Account.findAll({
      where: { companyId, code: rows.map((r) => r[0]) },
      attributes: ['id', 'code'],
      transaction: t,
    });
    for (const a of created) ids.set(a.code, String(a.id));
  }
  const series = await DocumentSequence.count({
    where: { companyId, docType: 'journal_entry' },
    transaction: t,
  });
  if (!series) {
    await DocumentSequence.create(
      { ...audit, docType: 'journal_entry', name: 'Journal entry', prefix: 'JV-{YYYY}-', padding: 5 },
      { transaction: t },
    );
  }
}

/** Make sure the company has a chart of accounts (created on first use). */
export async function ensureLedger(companyId, t) {
  const key = String(companyId);
  if (provisioned.has(key)) return;
  const exists = () => Account.count({ where: { companyId }, paranoid: false, transaction: t });
  if (!(await exists())) {
    // Serialise first-time provisioning per company.
    await Company.findByPk(companyId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
    if (!(await exists())) {
      await provisionLedger(companyId, t);
      // Remember it only once committed: a rolled-back provisioning leaves no accounts behind.
      t.afterCommit(() => provisioned.add(key));
      return;
    }
  }
  provisioned.add(key);
}

/**
 * Every posting needs the account map and the locked periods; both change rarely, so they are cached
 * per company for a minute (and dropped at once by the code that changes them in this process).
 */
const CACHE_TTL = 60_000;
const mapCache = new Map();
const lockCache = new Map();
const cached = async (cache, companyId, load) => {
  // Not while the chart is being created in an uncommitted transaction.
  if (!provisioned.has(String(companyId))) return load();
  const hit = cache.get(String(companyId));
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await load();
  cache.set(String(companyId), { at: Date.now(), value });
  return value;
};
/** Call after changing the account mapping or the period locks of a company. */
export function forgetLedgerCache(companyId) {
  mapCache.delete(String(companyId));
  lockCache.delete(String(companyId));
}

/** Mapping key → account id: Settings → Account mapping overrides, else the seeded system account. */
export async function accountMap(companyId, t) {
  const map = await cached(mapCache, companyId, async () => {
    const accounts = await Account.findAll({
      where: { companyId, systemKey: { [Op.ne]: null } },
      attributes: ['id', 'systemKey'],
      transaction: t,
    });
    const loaded = new Map(accounts.map((a) => [a.systemKey, String(a.id)]));
    const { accounts: overrides = {} } = await getSettings(companyId, 'accounting', t);
    for (const [k, v] of Object.entries(overrides)) if (v) loaded.set(k, String(v));
    return loaded;
  });
  return new Map(map);
}

/**
 * Ledger account of a payment method: its own, else the default for its type. A cheque received
 * waits in "cheques in hand" until it clears; a cheque paid out is credited to the bank at once.
 */
export function methodAccountId(method, map, direction = 'in') {
  if (method.accountId) return String(method.accountId);
  if (method.type === 'cheque' && direction === 'in') return map.get('chequesInHand');
  return map.get(METHOD_DEFAULT_KEY[method.type] ?? 'bank');
}

/** Refuse postings dated inside a locked period. */
export async function assertOpenPeriod(companyId, date, t) {
  const locked = await cached(lockCache, companyId, async () =>
    (
      await FiscalPeriod.findAll({
        where: { companyId, status: 'locked' },
        attributes: ['name', 'startDate', 'endDate'],
        transaction: t,
      })
    ).map((p) => p.toJSON()),
  );
  const period = locked.find((p) => p.startDate <= date && p.endDate >= date);
  if (period) {
    const message = `The accounting period ${period.name} is locked; nothing can be posted on ${date}`;
    throw AppError.unprocessable(message, [{ field: 'date', message }]);
  }
}

const isActive = { reversedById: null, entryType: { [Op.ne]: 'reversal' }, status: 'posted' };

/**
 * Write a posted journal entry.
 *
 * lines: { key? (mapping key) | accountId, amount (signed: + debit, − credit) | debit / credit,
 *          partyId?, branchId?, description? }
 * Automatic entries (sourceType + event) are idempotent: an active entry for the same source and
 * event is returned instead of posting twice. Lines on the same account / party / branch are netted
 * unless `merge` is false. Returns null when every amount is zero. `accounts` is an accountMap()
 * the caller already loaded; `checkExisting: false` skips the idempotency lookup for callers that
 * post an event exactly once (stock valuation).
 */
export async function postJournal({
  companyId,
  userId = null,
  branchId = null,
  date,
  entryType = 'auto',
  sourceType = null,
  sourceId = null,
  sourceNo = null,
  event = null,
  reference = null,
  narration = null,
  lines,
  merge = true,
  checkPeriod = true,
  reversalOfId = null,
  accounts = null,
  checkExisting = true,
  transaction: t,
}) {
  if (!t) throw new Error('postJournal() must run inside a transaction');
  await ensureLedger(companyId, t);
  if (sourceType && event && checkExisting) {
    const existing = await JournalEntry.findOne({
      where: { companyId, sourceType, sourceId, event, ...isActive },
      transaction: t,
    });
    if (existing) return existing;
  }

  const map = accounts ?? (lines.some((l) => l.key) ? await accountMap(companyId, t) : null);
  const shaped = lines.map((l, i) => {
    const accountId = l.accountId ? String(l.accountId) : map.get(l.key);
    if (!accountId) throw AppError.unprocessable(`No ledger account is mapped for "${l.key}"`);
    const amount = l.amount != null ? D(l.amount) : D(l.debit).minus(D(l.credit));
    return {
      accountId,
      partyId: l.partyId ? String(l.partyId) : null,
      branchId: l.branchId ? String(l.branchId) : branchId ? String(branchId) : null,
      description: l.description ?? null,
      amount: D(fixed(amount)),
      order: i,
    };
  });

  let rows = shaped;
  if (merge) {
    const byKey = new Map();
    for (const l of shaped) {
      const k = `${l.accountId}|${l.partyId ?? ''}|${l.branchId ?? ''}`;
      const prev = byKey.get(k);
      if (prev) prev.amount = prev.amount.plus(l.amount);
      else byKey.set(k, { ...l });
    }
    rows = [...byKey.values()];
  }
  rows = rows.filter((l) => !l.amount.isZero());
  if (!rows.length) return null;

  const debit = rows.reduce((s, l) => (l.amount.gt(0) ? s.plus(l.amount) : s), D(0));
  const credit = rows.reduce((s, l) => (l.amount.lt(0) ? s.minus(l.amount) : s), D(0));
  if (!debit.eq(credit)) {
    logger.error('Unbalanced journal', { companyId, sourceType, sourceId, event, debit, credit });
    throw AppError.unprocessable(
      `The journal does not balance: debits ${debit.toFixed(2)} ≠ credits ${credit.toFixed(2)}`,
    );
  }
  if (checkPeriod) await assertOpenPeriod(companyId, date, t);

  const headerBranch = branchId ?? rows.find((l) => l.branchId)?.branchId ?? null;
  const number = await nextNumber({
    companyId,
    docType: 'journal_entry',
    branchId: headerBranch,
    transaction: t,
  });
  const entry = await JournalEntry.create(
    {
      companyId,
      branchId: headerBranch,
      number,
      entryDate: date,
      entryType,
      status: 'posted',
      sourceType,
      sourceId,
      sourceNo,
      event,
      reference,
      narration,
      totalDebit: fixed(debit),
      totalCredit: fixed(credit),
      reversalOfId,
      postedBy: userId,
      postedAt: new Date(),
      createdBy: userId,
      updatedBy: userId,
    },
    { transaction: t },
  );
  await JournalLine.bulkCreate(
    rows.map((l, i) => ({
      companyId,
      journalId: entry.id,
      branchId: l.branchId,
      accountId: l.accountId,
      partyId: l.partyId,
      debit: l.amount.gt(0) ? fixed(l.amount) : '0',
      credit: l.amount.lt(0) ? fixed(l.amount.neg()) : '0',
      description: l.description,
      sortOrder: i,
    })),
    { transaction: t },
  );
  return entry;
}

/** Post the mirror image of an entry (dated `date`) and link the two. */
export async function reverseJournal(
  entry,
  { userId = null, date, narration, checkPeriod = true, transaction: t },
) {
  if (entry.reversedById) throw AppError.conflict(`Journal ${entry.number} is already reversed`);
  if (entry.entryType === 'reversal') throw AppError.conflict('A reversing entry cannot be reversed');
  const lines = await JournalLine.findAll({
    where: { journalId: entry.id },
    order: [['sortOrder', 'ASC']],
    transaction: t,
  });
  const reversal = await postJournal({
    companyId: entry.companyId,
    userId,
    branchId: entry.branchId,
    date,
    entryType: 'reversal',
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    sourceNo: entry.sourceNo,
    reference: entry.number,
    narration: narration ?? `Reversal of ${entry.number}`,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      partyId: l.partyId,
      branchId: l.branchId,
      description: l.description,
      amount: D(l.credit).minus(l.debit),
    })),
    merge: false,
    checkPeriod,
    reversalOfId: entry.id,
    transaction: t,
  });
  await entry.update({ reversedById: reversal.id, updatedBy: userId }, { transaction: t });
  return reversal;
}

/** Reverse every active automatic entry of a source document (optionally only some events). */
export async function reverseSource({
  companyId,
  userId,
  sourceType,
  sourceId,
  events,
  date,
  transaction: t,
}) {
  const entries = await JournalEntry.findAll({
    where: { companyId, sourceType, sourceId, ...isActive, ...(events && { event: events }) },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const entry of entries) await reverseJournal(entry, { userId, date, transaction: t });
  return entries.length;
}
