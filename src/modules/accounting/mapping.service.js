import { sequelize } from '../../config/db.js';
import { Account, PaymentMethod } from '../../models.js';
import { invalid } from '../inventory/inventory.common.js';
import { getSettings, saveSettings } from '../settings/settings.service.js';
import { MAPPING_GROUPS, MAPPING_TYPES, METHOD_DEFAULT_KEY } from './chart.js';
import { accountMap, ensureLedger, forgetLedgerCache } from './ledger.service.js';

/**
 * Account mapping: which ledger account each automatic posting uses (Settings → Accounting) and
 * which cash / bank account each payment method moves money through.
 */

const accountRef = (a) => (a ? { id: String(a.id), code: a.code, name: a.name, nameBn: a.nameBn } : null);

export async function getMapping(ctx) {
  const companyId = ctx.auth.companyId;
  await sequelize.transaction((t) => ensureLedger(companyId, t));
  const [map, { accounts: overrides = {} }, methods] = await Promise.all([
    sequelize.transaction((t) => accountMap(companyId, t)),
    getSettings(companyId, 'accounting'),
    PaymentMethod.findAll({
      where: { companyId },
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
  ]);
  const ids = [
    ...new Set([
      ...map.values(),
      ...methods
        .map((m) => m.accountId)
        .filter(Boolean)
        .map(String),
    ]),
  ];
  const accounts = await Account.findAll({ where: { id: ids, companyId } });
  const accountOf = new Map(accounts.map((a) => [String(a.id), a]));
  return {
    groups: Object.fromEntries(
      Object.entries(MAPPING_GROUPS).map(([group, keys]) => [
        group,
        Object.entries(keys).map(([key, types]) => ({
          key,
          types,
          account: accountRef(accountOf.get(map.get(key))),
          isDefault: !overrides[key],
        })),
      ]),
    ),
    paymentMethods: methods.map((m) => ({
      id: String(m.id),
      name: m.name,
      type: m.type,
      isActive: m.isActive,
      account: accountRef(accountOf.get(m.accountId ? String(m.accountId) : '')),
      defaultAccount: accountRef(accountOf.get(map.get(METHOD_DEFAULT_KEY[m.type]))),
    })),
  };
}

export async function saveMapping(ctx, input) {
  const companyId = ctx.auth.companyId;
  await sequelize.transaction(async (t) => {
    await ensureLedger(companyId, t);
    const wanted = [
      ...Object.values(input.accounts ?? {}),
      ...Object.values(input.paymentMethods ?? {}),
    ].filter(Boolean);
    const accounts = await Account.findAll({ where: { id: wanted, companyId }, transaction: t });
    const accountOf = new Map(accounts.map((a) => [String(a.id), a]));
    const check = (field, id, types) => {
      if (!id) return;
      const a = accountOf.get(String(id));
      if (!a) throw invalid(field, 'Account not found');
      if (a.isGroup) throw invalid(field, `${a.name} is a group; choose an account under it`);
      if (!a.isActive) throw invalid(field, `${a.name} is inactive`);
      if (types && !types.includes(a.type)) throw invalid(field, `Choose a ${types.join(' or ')} account`);
    };
    for (const [key, id] of Object.entries(input.accounts ?? {}))
      check(`accounts.${key}`, id, MAPPING_TYPES[key]);
    for (const [methodId, id] of Object.entries(input.paymentMethods ?? {})) {
      check(`paymentMethods.${methodId}`, id, ['asset']);
      const method = await PaymentMethod.findOne({ where: { id: methodId, companyId }, transaction: t });
      if (!method) throw invalid(`paymentMethods.${methodId}`, 'Payment method not found');
      await method.update({ accountId: id ?? null, updatedBy: ctx.auth.userId }, { transaction: t });
    }
  });
  if (input.accounts) {
    const { accounts: stored = {} } = await getSettings(companyId, 'accounting');
    const next = { ...stored };
    for (const [key, id] of Object.entries(input.accounts)) {
      if (id) next[key] = String(id);
      else delete next[key];
    }
    await saveSettings(ctx, 'accounting', { accounts: next });
    forgetLedgerCache(companyId);
  }
  return getMapping(ctx);
}
