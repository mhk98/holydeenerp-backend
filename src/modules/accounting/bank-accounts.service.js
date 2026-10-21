import { Account, BankAccount, Branch, JournalLine } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { invalid } from '../inventory/inventory.common.js';
import { accountBalances } from './accounts.service.js';
import { accountMap, ensureLedger, fixed } from './ledger.service.js';

/**
 * Cash, bank and mobile-wallet accounts. Each one is backed by a ledger account: either an existing
 * cash / bank ledger, or a new one created next to the standard account of its kind
 * (Cash in Hand 1110 → 1111, 1112 …; Bank 1120 → 1121 …; Mobile wallets 1130 → 1131 …).
 */

const KIND_KEY = { cash: 'cash', bank: 'bank', mobile_wallet: 'mobileWallet' };
const SUBTYPE = { cash: 'cash', bank: 'bank', mobile_wallet: 'bank' };

/** Create the ledger account of a new money account. */
async function createLedger(ctx, data, t) {
  const map = await accountMap(ctx.auth.companyId, t);
  const anchor = await Account.findByPk(map.get(KIND_KEY[data.kind]), { transaction: t });
  if (!anchor) throw AppError.unprocessable('The standard cash / bank account is missing from the chart');
  const base = Number(anchor.code);
  const taken = new Set(
    (
      await Account.findAll({
        where: { companyId: ctx.auth.companyId },
        attributes: ['code'],
        paranoid: false,
        transaction: t,
      })
    ).map((a) => a.code),
  );
  let code = null;
  for (let n = 1; n <= 9 && Number.isFinite(base); n += 1) {
    if (!taken.has(String(base + n))) {
      code = String(base + n);
      break;
    }
  }
  // Ten per kind fit next to the anchor; beyond that, a longer code under it.
  for (let n = 1; !code && n <= 99; n += 1) {
    const candidate = `${anchor.code}-${String(n).padStart(2, '0')}`;
    if (!taken.has(candidate)) code = candidate;
  }
  return Account.create(
    {
      companyId: ctx.auth.companyId,
      parentId: anchor.parentId,
      code,
      name: data.name,
      type: 'asset',
      subtype: SUBTYPE[data.kind],
      isGroup: false,
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
}

const crud = createCrudService({
  model: BankAccount,
  label: 'Bank account',
  listOptions: {
    sortable: ['name', 'kind', 'createdAt'],
    searchable: ['name', 'bankName', 'accountNumber'],
    filterable: ['kind', 'isActive', 'branchId'],
    defaultSort: 'name',
  },
  include: () => [
    { model: Account, as: 'account', attributes: ['id', 'code', 'name', 'nameBn'], paranoid: false },
    { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
  ],

  async beforeSave(ctx, data, existing, t) {
    await ensureLedger(ctx.auth.companyId, t);
    if (existing && data.kind && data.kind !== existing.kind)
      throw invalid('kind', 'The kind of an account cannot change; create another one');
    if (data.branchId) {
      const branch = await Branch.count({
        where: { id: data.branchId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!branch) throw invalid('branchId', 'Branch not found');
    }
    if (!existing) {
      if (data.accountId) {
        const ledger = await Account.findOne({
          where: { id: data.accountId, companyId: ctx.auth.companyId },
          transaction: t,
        });
        if (
          !ledger ||
          ledger.isGroup ||
          ledger.type !== 'asset' ||
          !['cash', 'bank'].includes(ledger.subtype)
        )
          throw invalid('accountId', 'Choose a cash or bank ledger account');
        if (await BankAccount.count({ where: { accountId: ledger.id }, transaction: t }))
          throw invalid('accountId', 'Another money account already uses this ledger account');
      } else {
        data.accountId = (await createLedger(ctx, data, t)).id;
      }
    } else if (data.name && data.name !== existing.name) {
      // Keep the ledger's name in step unless it is a standard (system) account.
      const ledger = await Account.findByPk(existing.accountId, { transaction: t });
      if (ledger && !ledger.isSystem)
        await ledger.update({ name: data.name, updatedBy: ctx.auth.userId }, { transaction: t });
    }
    if (existing) delete data.accountId;
    return data;
  },

  async beforeDelete(ctx, bank, t) {
    if (await JournalLine.count({ where: { accountId: bank.accountId }, transaction: t }))
      throw AppError.conflict('This account has transactions; deactivate it instead');
    const ledger = await Account.findByPk(bank.accountId, { transaction: t });
    if (ledger && !ledger.isSystem) {
      await ledger.update({ code: `${ledger.code}~${ledger.id}`.slice(0, 20) }, { transaction: t });
      await ledger.destroy({ transaction: t });
    }
  },
});

/** Ledger balance of each money account (as of today, or `asOf`). */
async function withBalances(ctx, rows, asOf) {
  const balances = await accountBalances(ctx.auth.companyId, { asOf });
  return rows.map((r) => ({ ...r, balance: fixed(balances.get(String(r.accountId)) ?? 0) }));
}

export const bankAccounts = {
  ...crud,
  async list(ctx, query) {
    const result = await crud.list(ctx, query);
    return { ...result, rows: await withBalances(ctx, result.rows, query.asOf) };
  },
  async get(ctx, id) {
    const [row] = await withBalances(ctx, [await crud.get(ctx, id)]);
    return row;
  },
  // Same shape as get (with the balance) after a save.
  async create(ctx, input) {
    return bankAccounts.get(ctx, (await crud.create(ctx, input)).id);
  },
  async update(ctx, id, input) {
    await crud.update(ctx, id, input);
    return bankAccounts.get(ctx, id);
  },
};

/** Active money accounts for pickers (vouchers, expenses, deposits). */
export async function bankAccountOptions(ctx) {
  const rows = await BankAccount.findAll({
    where: { companyId: ctx.auth.companyId, isActive: true },
    include: [{ model: Account, as: 'account', attributes: ['id', 'code', 'name'] }],
    order: [
      ['kind', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  return withBalances(
    ctx,
    rows.map((r) => r.toJSON()),
  );
}

/** A money account of the company (locked when `t` is given). */
export async function findBankAccount(ctx, id, field, t) {
  const bank = await BankAccount.findOne({
    where: { id, companyId: ctx.auth.companyId, isActive: true },
    transaction: t,
  });
  if (!bank) throw invalid(field, 'Cash / bank account not found');
  return bank;
}
