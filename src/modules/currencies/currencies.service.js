import Decimal from 'decimal.js';
import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Currency, ExchangeRate } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { parseListQuery } from '../../utils/pagination.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Latest rate per currency on or before `date` → { [currencyId]: { rate, effectiveDate } }. */
async function latestRates(companyId, currencyIds, date = today()) {
  if (!currencyIds.length) return {};
  const rows = await ExchangeRate.findAll({
    where: { companyId, currencyId: currencyIds, effectiveDate: { [Op.lte]: date } },
    order: [
      ['effectiveDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const latest = {};
  for (const r of rows) latest[String(r.currencyId)] ??= { rate: r.rate, effectiveDate: r.effectiveDate };
  return latest;
}

const crud = createCrudService({
  model: Currency,
  label: 'Currency',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['code', 'name', 'createdAt'],
    searchable: ['code', 'name'],
    filterable: ['isActive', 'isBase'],
    defaultSort: 'code',
  },
  beforeSave: async (ctx, data, existing) => {
    if (data.code) data.code = data.code.toUpperCase();
    if (existing?.isBase && data.isActive === false) {
      throw AppError.badRequest('The base currency cannot be deactivated');
    }
    if (existing?.isBase && data.code && data.code !== existing.code) {
      throw AppError.badRequest('Change the base currency in Financial settings instead of renaming it');
    }
    return data;
  },
  beforeDelete: async (ctx, currency) => {
    if (currency.isBase) throw AppError.badRequest('The base currency cannot be deleted');
    // Documents and journals are kept in the base currency, so no other record refers to a foreign
    // currency (its exchange rates belong to it). When documents get a currency, block deletion here.
  },
});

/** Currency CRUD where every currency carries its current exchange rate. */
export const currencyCrud = {
  ...crud,
  async list(ctx, query) {
    const result = await crud.list(ctx, query);
    const rates = await latestRates(
      ctx.auth.companyId,
      result.rows.map((c) => c.id),
    );
    result.rows = result.rows.map((c) => ({
      ...c,
      latestRate: c.isBase ? null : (rates[String(c.id)] ?? null),
    }));
    return result;
  },
  async get(ctx, id) {
    const currency = await crud.get(ctx, id);
    const rates = await latestRates(ctx.auth.companyId, [currency.id]);
    return { ...currency, latestRate: currency.isBase ? null : (rates[String(currency.id)] ?? null) };
  },
};

// ── Exchange rates ─────────────────────────────────────────────────────────

export async function listRates(ctx, currencyId, query) {
  await crud.find(ctx, currencyId);
  const q = parseListQuery(query, { sortable: ['effectiveDate'], defaultSort: '-effectiveDate' });
  const { rows, count } = await ExchangeRate.findAndCountAll({
    where: { companyId: ctx.auth.companyId, currencyId },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

/** Add a rate; a second rate for the same date replaces the first. */
export async function setRate(ctx, currencyId, { rate, effectiveDate = today() }) {
  const currency = await crud.find(ctx, currencyId);
  if (currency.isBase) throw AppError.badRequest('The base currency always has a rate of 1');

  return sequelize.transaction(async (t) => {
    const existing = await ExchangeRate.findOne({
      where: { companyId: ctx.auth.companyId, currencyId, effectiveDate },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (existing) {
      await existing.update({ rate, updatedBy: ctx.auth.userId }, { transaction: t });
      return existing.toJSON();
    }
    const created = await ExchangeRate.create(
      {
        companyId: ctx.auth.companyId,
        currencyId,
        rate,
        effectiveDate,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    return created.toJSON();
  });
}

export async function deleteRate(ctx, currencyId, rateId) {
  const deleted = await ExchangeRate.destroy({
    where: { id: rateId, currencyId, companyId: ctx.auth.companyId },
  });
  if (!deleted) throw AppError.notFound('Exchange rate not found');
}

// ── Helpers for other modules ──────────────────────────────────────────────

export async function getBaseCurrency(companyId, transaction) {
  return Currency.findOne({ where: { companyId, isBase: true }, transaction });
}

/** Rate of `code` against the base currency on `date` (1 for the base). Throws if missing. */
export async function getRate(companyId, code, date = today()) {
  const currency = await Currency.findOne({ where: { companyId, code } });
  if (!currency) throw AppError.badRequest(`Unknown currency ${code}`);
  if (currency.isBase) return '1';
  const rates = await latestRates(companyId, [currency.id], date);
  const found = rates[String(currency.id)];
  if (!found) throw AppError.badRequest(`No exchange rate for ${code} on or before ${date}`);
  return found.rate;
}

/** Convert an amount between currencies via the base currency (string in, string out). */
export async function convert(companyId, amount, from, to, date = today(), decimals = 4) {
  if (from === to) return new Decimal(amount).toFixed(decimals);
  const [fromRate, toRate] = await Promise.all([
    getRate(companyId, from, date),
    getRate(companyId, to, date),
  ]);
  return new Decimal(amount).times(fromRate).dividedBy(toRate).toFixed(decimals);
}

/** Make `code` the base currency (Financial settings). Old rates of the new base are removed. */
export async function setBaseCurrency(companyId, code, userId, transaction) {
  const currency = await Currency.findOne({ where: { companyId, code, isActive: true }, transaction });
  if (!currency) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'baseCurrency', message: 'Choose an active currency' },
    ]);
  }
  if (currency.isBase) return;
  await Currency.update({ isBase: false }, { where: { companyId, isBase: true }, transaction });
  await currency.update({ isBase: true, updatedBy: userId }, { transaction });
  await ExchangeRate.destroy({ where: { companyId, currencyId: currency.id }, transaction, force: true });
}
