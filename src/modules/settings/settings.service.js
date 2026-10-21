import { sequelize } from '../../config/db.js';
import { Company, Setting } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { decrypt, encrypt } from '../../utils/crypto.js';
import { getBaseCurrency, setBaseCurrency } from '../currencies/currencies.service.js';
import { SETTING_GROUPS } from './settings.groups.js';

function definition(group) {
  const def = SETTING_GROUPS[group];
  if (!def) throw AppError.notFound(`Unknown settings group "${group}"`);
  return def;
}

const scopeId = (def, companyId) => (def.scope === 'system' ? null : companyId);

async function loadRow(group, companyId, transaction) {
  const def = definition(group);
  return Setting.findOne({ where: { group, companyId: scopeId(def, companyId) }, transaction });
}

/**
 * Effective settings of a group: defaults merged with what is saved. Secrets are decrypted
 * (for server-side use only — never send this object to clients).
 */
export async function getSettings(companyId, group, transaction) {
  const def = definition(group);
  const row = await loadRow(group, companyId, transaction);
  const stored = row ? JSON.parse(row.value) : {};
  const merged = { ...def.defaults, ...stored };
  for (const key of def.secrets ?? []) {
    merged[key] = stored[key] ? decrypt(stored[key]) : '';
  }
  return merged;
}

/** Client-safe view: secrets replaced by `has<Key>` flags. */
export async function getPublicSettings(companyId, group) {
  const def = definition(group);
  const value = await getSettings(companyId, group);
  for (const key of def.secrets ?? []) {
    value[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(value[key]);
    delete value[key];
  }
  if (group === 'financial') {
    // The base currency lives on the currencies table; keep the setting in sync with it.
    const base = await getBaseCurrency(companyId);
    if (base) value.baseCurrency = base.code;
  }
  return value;
}

/**
 * Save part of a group. Unknown keys are rejected; secrets left empty keep their stored value.
 * Financial: changing baseCurrency switches the currencies' base flag in the same transaction.
 */
export async function saveSettings(ctx, group, input) {
  const def = definition(group);
  const patch = def.schema.partial().strict().parse(input);

  await sequelize.transaction(async (t) => {
    const row = await loadRow(group, ctx.auth.companyId, t);
    const stored = row ? JSON.parse(row.value) : {};

    for (const key of def.secrets ?? []) {
      if (patch[key] === undefined || patch[key] === '') delete patch[key];
      else patch[key] = encrypt(patch[key]);
    }

    const next = { ...stored, ...patch };
    const effective = { ...def.defaults, ...next };
    for (const key of def.secrets ?? []) effective[key] = next[key] ? 'set' : '';
    const problem = def.refine?.(effective);
    if (problem) throw AppError.unprocessable(problem);

    if (group === 'financial' && patch.baseCurrency) {
      await setBaseCurrency(ctx.auth.companyId, patch.baseCurrency, ctx.auth.userId, t);
    }
    if (group === 'system' && patch.timezone) {
      await Company.update(
        { timezone: patch.timezone },
        { where: { id: ctx.auth.companyId }, transaction: t },
      );
    }

    const value = JSON.stringify(next);
    if (row) await row.update({ value, updatedBy: ctx.auth.userId }, { transaction: t });
    else {
      await Setting.create(
        {
          companyId: scopeId(def, ctx.auth.companyId),
          group,
          value,
          createdBy: ctx.auth.userId,
          updatedBy: ctx.auth.userId,
        },
        { transaction: t },
      );
    }
  });

  return getPublicSettings(ctx.auth.companyId, group);
}

/** Everything the web app needs at start-up for formatting and theming (any signed-in user). */
export async function getAppConfig(companyId) {
  const [company, financial, system, inventory, base] = await Promise.all([
    Company.findByPk(companyId, { attributes: ['id', 'name', 'code', 'logoUrl', 'binNo', 'timezone'] }),
    getPublicSettings(companyId, 'financial'),
    getPublicSettings(companyId, 'system'),
    getPublicSettings(companyId, 'inventory'),
    getBaseCurrency(companyId),
  ]);
  return {
    company: company && { ...company.toJSON(), id: String(company.id) },
    financial,
    system,
    inventory,
    baseCurrency: base ? { code: base.code, symbol: base.symbol, decimalPlaces: base.decimalPlaces } : null,
  };
}
