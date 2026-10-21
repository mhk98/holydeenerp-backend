import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Account, JournalLine, PaymentMethod } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { invalid } from '../inventory/inventory.common.js';
import { getSettings } from '../settings/settings.service.js';
import { ACCOUNT_SUBTYPES, DEBIT_NORMAL } from './accounting.model.js';
import { D, ensureLedger, fixed } from './ledger.service.js';

/**
 * Chart of accounts: a tree of group accounts (headings) and ledger accounts (postable).
 * A child takes its parent's type; system accounts (seeded headings and mapping defaults) can be
 * renamed but not deleted or retyped. Accounts with postings keep their type and kind.
 */

async function hasPostings(accountId, t) {
  return (await JournalLine.count({ where: { accountId }, transaction: t })) > 0;
}

/** Ids of an account and everything below it. */
async function subtreeIds(companyId, rootId, t) {
  const all = await Account.findAll({ where: { companyId }, attributes: ['id', 'parentId'], transaction: t });
  const ids = new Set([String(rootId)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of all) {
      if (a.parentId && ids.has(String(a.parentId)) && !ids.has(String(a.id))) {
        ids.add(String(a.id));
        grew = true;
      }
    }
  }
  return ids;
}

export const accounts = createCrudService({
  model: Account,
  label: 'Account',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['code', 'name', 'type', 'createdAt'],
    searchable: ['code', 'name', 'nameBn'],
    filterable: ['type', 'subtype', 'isGroup', 'isActive', 'parentId'],
    defaultSort: 'code',
  },
  include: () => [{ model: Account, as: 'parent', attributes: ['id', 'code', 'name'] }],

  async beforeSave(ctx, data, existing, t) {
    await ensureLedger(ctx.auth.companyId, t);
    const parentId = data.parentId !== undefined ? data.parentId : (existing?.parentId ?? null);
    let parent = null;
    if (parentId) {
      parent = await Account.findOne({
        where: { id: parentId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!parent) throw invalid('parentId', 'Parent account not found');
      if (!parent.isGroup) throw invalid('parentId', 'The parent must be a group account');
      if (existing && (await subtreeIds(ctx.auth.companyId, existing.id, t)).has(String(parent.id)))
        throw invalid('parentId', 'An account cannot sit under itself');
    }
    const type = parent?.type ?? data.type ?? existing?.type;
    if (!type) throw invalid('type', 'Choose the account type');
    if (data.type && parent && data.type !== parent.type)
      throw invalid('type', `Accounts under ${parent.name} are ${parent.type} accounts`);
    const subtype =
      data.subtype ?? (existing && existing.type === type ? existing.subtype : null) ?? parent?.subtype;
    if (!subtype || !ACCOUNT_SUBTYPES[type].includes(subtype))
      throw invalid('subtype', `Choose a ${type} category`);

    if (existing) {
      if (existing.isSystem && type !== existing.type)
        throw invalid('type', 'The type of a system account cannot change');
      const isGroup = data.isGroup ?? existing.isGroup;
      if (isGroup !== existing.isGroup) {
        if (existing.isSystem)
          throw invalid('isGroup', 'A system account cannot change between group and ledger');
        if (isGroup && (await hasPostings(existing.id, t)))
          throw invalid('isGroup', 'This account has postings; it cannot become a group');
        if (!isGroup && (await Account.count({ where: { parentId: existing.id }, transaction: t })))
          throw invalid('isGroup', 'Move the accounts under this group first');
      }
      if (type !== existing.type && (await hasPostings(existing.id, t)))
        throw invalid('type', 'This account has postings; its type cannot change');
      if (
        type !== existing.type &&
        (await Account.count({ where: { parentId: existing.id }, transaction: t }))
      )
        throw invalid('type', 'Move the accounts under this group first');
    }
    return { ...data, type, subtype, parentId: parentId ?? null };
  },

  async beforeDelete(ctx, account, t) {
    if (account.isSystem) throw AppError.conflict('System accounts cannot be deleted; deactivate it instead');
    if (await Account.count({ where: { parentId: account.id }, transaction: t }))
      throw AppError.conflict('Move or delete the accounts under this group first');
    if (await hasPostings(account.id, t))
      throw AppError.conflict('This account has postings; deactivate it instead');
    const { accounts: mapped = {} } = await getSettings(ctx.auth.companyId, 'accounting', t);
    if (Object.values(mapped).some((v) => String(v) === String(account.id)))
      throw AppError.conflict('This account is used in the account mapping');
    if (await PaymentMethod.count({ where: { accountId: account.id }, transaction: t }))
      throw AppError.conflict('A payment method posts to this account');
  },
});

/**
 * Posted balance per account up to `asOf` (signed debit − credit), optionally by branch.
 * @returns {Promise<Map<string, Decimal>>}
 */
export async function accountBalances(companyId, { asOf, from, branchIds } = {}) {
  const rows = await sequelize.query(
    `SELECT l.account_id AS accountId, SUM(l.debit) - SUM(l.credit) AS balance
       FROM journal_lines l
       JOIN journal_entries j ON j.id = l.journal_id
      WHERE l.company_id = :companyId AND j.status = 'posted' AND j.deleted_at IS NULL
        ${asOf ? 'AND j.entry_date <= :asOf' : ''}
        ${from ? 'AND j.entry_date >= :from' : ''}
        ${branchIds ? 'AND l.branch_id IN (:branchIds)' : ''}
      GROUP BY l.account_id`,
    { replacements: { companyId, asOf, from, branchIds }, type: QueryTypes.SELECT },
  );
  return new Map(rows.map((r) => [String(r.accountId), D(r.balance)]));
}

/** Natural-sign balance: positive when the account carries its normal balance. */
export const naturalBalance = (type, signed) => (DEBIT_NORMAL.has(type) ? D(signed) : D(signed).neg());

/** The chart as a nested tree, with balances rolled up into the groups when asked. */
export async function accountTree(ctx, query = {}) {
  await sequelize.transaction((t) => ensureLedger(ctx.auth.companyId, t));
  const where = { companyId: ctx.auth.companyId };
  if (query.includeInactive !== 'true') where.isActive = true;
  const rows = await Account.findAll({ where, order: [['code', 'ASC']] });
  const balances =
    query.balances === 'true' ? await accountBalances(ctx.auth.companyId, { asOf: query.asOf }) : null;

  const nodes = new Map(
    rows.map((a) => [String(a.id), { ...a.toJSON(), id: String(a.id), children: [], balance: D(0) }]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(String(node.parentId)) : null;
    (parent ? parent.children : roots).push(node);
  }
  const rollUp = (node) => {
    const own = balances?.get(node.id) ?? D(0);
    node.balance = node.children.reduce((s, c) => s.plus(rollUp(c)), own);
    return node.balance;
  };
  const finish = (node) => ({
    ...node,
    balance: balances ? fixed(naturalBalance(node.type, node.balance)) : undefined,
    children: node.children.map(finish),
  });
  if (balances) roots.forEach(rollUp);
  return roots.map(finish);
}

/** Postable accounts for pickers (ledger accounts, active), lightest shape. */
export async function accountOptions(ctx, { type } = {}) {
  await sequelize.transaction((t) => ensureLedger(ctx.auth.companyId, t));
  return Account.findAll({
    where: {
      companyId: ctx.auth.companyId,
      isGroup: false,
      isActive: true,
      ...(type && { type: { [Op.in]: String(type).split(',') } }),
    },
    attributes: ['id', 'code', 'name', 'nameBn', 'type', 'subtype', 'systemKey'],
    order: [['code', 'ASC']],
  });
}
