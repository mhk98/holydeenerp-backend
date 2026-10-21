import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Account, Branch, JournalEntry, JournalLine, Party, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday, invalid } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  D,
  accountMap,
  assertOpenPeriod,
  ensureLedger,
  fixed,
  postJournal,
  reverseJournal,
} from './ledger.service.js';

/**
 * Journal entries. Manual entries start as drafts (or post right away) and are balanced, dated in an
 * open period, on ledger accounts; receivable / payable lines name the party. Automatic entries come
 * from the posting service and are only undone through their source document. Posted entries are
 * corrected with a reversing entry, never edited.
 */

const LABEL = 'Journal entry';
const LIST_OPTIONS = {
  sortable: ['number', 'entryDate', 'totalDebit', 'createdAt'],
  searchable: ['number', 'narration', 'reference', 'sourceNo'],
  filterable: ['status', 'entryType', 'sourceType', 'sourceId'],
  defaultSort: '-entryDate',
};

/** Branch visibility: the user's branches plus company-level entries (no branch). */
const visible = (ctx) => ({
  [Op.or]: [{ branchId: null }, { branchId: { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] } }],
});

const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });

export async function listJournals(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const and = [q.where, { companyId: ctx.auth.companyId }, visible(ctx)];
  if (query.from || query.to) {
    and.push({
      entryDate: { ...(query.from && { [Op.gte]: query.from }), ...(query.to && { [Op.lte]: query.to }) },
    });
  }
  if (query.accountId || query.partyId) {
    and.push({
      id: {
        [Op.in]: sequelize.literal(
          `(SELECT journal_id FROM journal_lines WHERE company_id = ${sequelize.escape(ctx.auth.companyId)}${
            query.accountId ? ` AND account_id = ${sequelize.escape(query.accountId)}` : ''
          }${query.partyId ? ` AND party_id = ${sequelize.escape(query.partyId)}` : ''})`,
        ),
      },
    });
  }
  const { rows, count } = await JournalEntry.findAndCountAll({
    where: { [Op.and]: and },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }, userRef('creator')],
    order: [...q.order, ['id', 'DESC']],
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getJournal(ctx, id, t) {
  const doc = await JournalEntry.findOne({
    where: { [Op.and]: [{ id, companyId: ctx.auth.companyId }, visible(ctx)] },
    include: [
      { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
      userRef('creator'),
      userRef('poster'),
      { model: JournalEntry, as: 'reversalOf', attributes: ['id', 'number', 'entryDate'] },
      { model: JournalEntry, as: 'reversedBy', attributes: ['id', 'number', 'entryDate'] },
      {
        model: JournalLine,
        as: 'lines',
        separate: true,
        order: [['sortOrder', 'ASC']],
        include: [
          {
            model: Account,
            as: 'account',
            attributes: ['id', 'code', 'name', 'nameBn', 'type'],
            paranoid: false,
          },
          { model: Party, as: 'party', attributes: ['id', 'code', 'name'], paranoid: false },
          { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
        ],
      },
    ],
    transaction: t,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

/** Journals of a business document (for "View journal" links on documents). */
export async function sourceJournals(ctx, sourceType, sourceId) {
  const rows = await JournalEntry.findAll({
    where: { [Op.and]: [{ companyId: ctx.auth.companyId, sourceType, sourceId }, visible(ctx)] },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  return Promise.all(rows.map((r) => getJournal(ctx, r.id)));
}

/** Validate manual lines; returns them with resolved accounts. */
async function checkLines(ctx, lines, t) {
  const accountIds = [...new Set(lines.map((l) => String(l.accountId)))];
  const accounts = await Account.findAll({
    where: { id: accountIds, companyId: ctx.auth.companyId },
    transaction: t,
  });
  const accountOf = new Map(accounts.map((a) => [String(a.id), a]));
  const partyIds = [...new Set(lines.filter((l) => l.partyId).map((l) => String(l.partyId)))];
  const parties = partyIds.length
    ? await Party.findAll({ where: { id: partyIds, companyId: ctx.auth.companyId }, transaction: t })
    : [];
  const partyOf = new Map(parties.map((p) => [String(p.id), p]));

  let debit = D(0);
  let credit = D(0);
  lines.forEach((l, i) => {
    const a = accountOf.get(String(l.accountId));
    if (!a) throw invalid(`lines.${i}.accountId`, 'Account not found');
    if (a.isGroup) throw invalid(`lines.${i}.accountId`, `${a.name} is a group; choose an account under it`);
    if (!a.isActive) throw invalid(`lines.${i}.accountId`, `${a.name} is inactive`);
    if (l.partyId && !partyOf.has(String(l.partyId))) throw invalid(`lines.${i}.partyId`, 'Party not found');
    if (['receivable', 'payable'].includes(a.subtype) && !l.partyId)
      throw invalid(
        `lines.${i}.partyId`,
        `Choose the ${a.subtype === 'receivable' ? 'customer' : 'supplier'}`,
      );
    if (l.branchId) assertBranchAccess(ctx, l.branchId);
    debit = debit.plus(l.debit);
    credit = credit.plus(l.credit);
  });
  if (!debit.eq(credit))
    throw invalid('lines', `Debits (${debit.toFixed(2)}) and credits (${credit.toFixed(2)}) must be equal`);
  return { debit, credit };
}

async function writeDraft(ctx, doc, input, t) {
  if (input.branchId) assertBranchAccess(ctx, input.branchId);
  const { debit, credit } = await checkLines(ctx, input.lines, t);
  await doc.update(
    {
      entryDate: input.entryDate,
      branchId: input.branchId ?? null,
      reference: input.reference ?? null,
      narration: input.narration ?? null,
      totalDebit: fixed(debit),
      totalCredit: fixed(credit),
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await JournalLine.destroy({ where: { journalId: doc.id }, transaction: t });
  await JournalLine.bulkCreate(
    input.lines.map((l, i) => ({
      companyId: ctx.auth.companyId,
      journalId: doc.id,
      branchId: l.branchId ?? input.branchId ?? null,
      accountId: l.accountId,
      partyId: l.partyId ?? null,
      debit: fixed(l.debit),
      credit: fixed(l.credit),
      description: l.description ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
}

async function postDraft(ctx, doc, t) {
  await assertOpenPeriod(ctx.auth.companyId, doc.entryDate, t);
  await doc.update(
    { status: 'posted', postedBy: ctx.auth.userId, postedAt: new Date(), updatedBy: ctx.auth.userId },
    { transaction: t },
  );
}

async function lockJournal(ctx, id, t, allowed) {
  const doc = await JournalEntry.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  if (doc.branchId) assertBranchAccess(ctx, doc.branchId);
  if (allowed && !allowed.includes(doc.status))
    throw AppError.conflict(`${LABEL} ${doc.number} is ${doc.status}; this action is not allowed`);
  return doc;
}

export async function createJournal(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    await ensureLedger(ctx.auth.companyId, t);
    const doc = await JournalEntry.create(
      {
        companyId: ctx.auth.companyId,
        branchId: input.branchId ?? null,
        number: await nextNumber({
          companyId: ctx.auth.companyId,
          docType: 'journal_entry',
          branchId: input.branchId ?? null,
          transaction: t,
        }),
        entryDate: input.entryDate,
        entryType: 'manual',
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, doc, input, t);
    if (input.post) await postDraft(ctx, doc, t);
    return doc.id;
  });
  return getJournal(ctx, id);
}

export async function updateJournal(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockJournal(ctx, id, t, ['draft']);
    await writeDraft(ctx, doc, input, t);
    if (input.post) await postDraft(ctx, doc, t);
  });
  return getJournal(ctx, id);
}

export async function postJournalEntry(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockJournal(ctx, id, t, ['draft']);
    const lines = await JournalLine.findAll({ where: { journalId: doc.id }, transaction: t });
    await checkLines(
      ctx,
      lines.map((l) => l.toJSON()),
      t,
    );
    await postDraft(ctx, doc, t);
  });
  return getJournal(ctx, id);
}

export async function deleteJournal(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockJournal(ctx, id, t, ['draft']);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Reverse a posted manual / opening entry (automatic ones are undone through their document). */
export async function reverseJournalEntry(ctx, id, input = {}) {
  const reversalId = await sequelize.transaction(async (t) => {
    const doc = await lockJournal(ctx, id, t, ['posted']);
    if (doc.entryType === 'auto')
      throw AppError.conflict('This entry was posted by a document; cancel or void that document instead');
    if (doc.entryType === 'closing')
      throw AppError.conflict('Reopen the fiscal year to undo its closing entry');
    const reversal = await reverseJournal(doc, {
      userId: ctx.auth.userId,
      date: input.date ?? (await companyToday(ctx.auth.companyId)),
      narration: input.narration,
      transaction: t,
    });
    return reversal.id;
  });
  return getJournal(ctx, reversalId);
}

// ── Opening balances ──────────────────────────────────────────────────────

const OPENING = { entryType: 'opening', sourceType: 'opening_balance', event: 'post' };

/** The active opening-balance entry (accounts other than customers, suppliers and stock). */
export async function getOpeningBalances(ctx) {
  const entry = await JournalEntry.findOne({
    where: { companyId: ctx.auth.companyId, ...OPENING, status: 'posted', reversedById: null },
    order: [['id', 'DESC']],
  });
  return entry ? getJournal(ctx, entry.id) : null;
}

/**
 * Replace the opening balances: the previous opening entry is reversed and a new one posted;
 * the difference goes to Opening Balance Equity. Customers, suppliers and stock get their opening
 * balances from their own records (party opening balance, opening stock).
 */
export async function saveOpeningBalances(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    await ensureLedger(ctx.auth.companyId, t);
    const map = await accountMap(ctx.auth.companyId, t);
    const lines = input.lines.filter((l) => D(l.debit).gt(0) || D(l.credit).gt(0));
    const accounts = await Account.findAll({
      where: { id: lines.map((l) => l.accountId), companyId: ctx.auth.companyId },
      transaction: t,
    });
    const accountOf = new Map(accounts.map((a) => [String(a.id), a]));
    lines.forEach((l, i) => {
      const a = accountOf.get(String(l.accountId));
      if (!a || a.isGroup) throw invalid(`lines.${i}.accountId`, 'Choose a ledger account');
      if (['receivable', 'payable', 'inventory'].includes(a.subtype))
        throw invalid(
          `lines.${i}.accountId`,
          `${a.name}: enter opening balances on the customers / suppliers, and opening stock in Inventory`,
        );
      if (String(a.id) === map.get('openingBalanceEquity'))
        throw invalid(`lines.${i}.accountId`, 'Opening Balance Equity takes the difference automatically');
    });

    const previous = await JournalEntry.findAll({
      where: { companyId: ctx.auth.companyId, ...OPENING, status: 'posted', reversedById: null },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    for (const entry of previous) {
      await reverseJournal(entry, {
        userId: ctx.auth.userId,
        date: entry.entryDate,
        checkPeriod: false,
        transaction: t,
      });
    }
    const signed = lines.map((l) => ({ accountId: l.accountId, amount: D(l.debit).minus(l.credit) }));
    const diff = signed.reduce((s, l) => s.plus(l.amount), D(0));
    if (!signed.length) return null;
    const entry = await postJournal({
      companyId: ctx.auth.companyId,
      userId: ctx.auth.userId,
      date: input.date,
      ...OPENING,
      narration: 'Opening balances',
      lines: [...signed, { key: 'openingBalanceEquity', amount: diff.neg() }],
      merge: false,
      accounts: map,
      transaction: t,
    });
    return entry.id;
  });
  return id ? getJournal(ctx, id) : null;
}
