import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { PartyGroup, PriceList, PriceListItem } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { normalizeLines } from '../inventory/inventory.common.js';
import { purchaseLookups } from '../purchase/conversions.service.js';
import { fixed, invalid, salesLineIncludes, salesSettings } from './sales.common.js';

/**
 * Price lists per customer group. Each row sets a fixed price (per unit) or a % off the standard
 * sale price, optionally from a minimum quantity. When several lists of a group are valid, the one
 * with the highest priority wins (see resolvePrices in sales.common.js).
 */

const LABEL = 'Price list';

export async function listPriceLists(ctx, query) {
  const q = parseListQuery(query, {
    sortable: ['name', 'code', 'priority', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['customerGroupId', 'isActive'],
    defaultSort: 'name',
  });
  const { rows, count } = await PriceList.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId },
    include: [{ model: PartyGroup, as: 'customerGroup', attributes: ['id', 'name', 'code'] }],
    attributes: {
      include: [
        [
          sequelize.literal('(SELECT COUNT(*) FROM price_list_items i WHERE i.price_list_id = PriceList.id)'),
          'itemsCount',
        ],
      ],
    },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function getPriceList(ctx, id) {
  const doc = await PriceList.findOne({
    where: { id, companyId: ctx.auth.companyId },
    include: [
      { model: PartyGroup, as: 'customerGroup', attributes: ['id', 'name', 'code'] },
      {
        model: PriceListItem,
        as: 'items',
        include: salesLineIncludes({ tax: false }),
        separate: true,
        order: [['id', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  return doc.toJSON();
}

async function write(ctx, doc, input, t) {
  if (input.customerGroupId) {
    const group = await PartyGroup.count({
      where: { id: input.customerGroupId, companyId: ctx.auth.companyId, type: 'customer' },
      transaction: t,
    });
    if (!group) throw invalid('customerGroupId', 'Customer group not found');
  }
  const code = input.code.toUpperCase();
  const clash = await PriceList.count({
    where: { companyId: ctx.auth.companyId, code, ...(doc && { id: { [Op.ne]: doc.id } }) },
    transaction: t,
  });
  if (clash)
    throw AppError.conflict('Price list already exists', [
      { field: 'code', message: 'This code is already in use' },
    ]);
  const lines = input.items.length
    ? await normalizeLines(
        ctx,
        input.items.map((i) => ({ ...i, quantity: i.minQuantity || '1' })),
        t,
      )
    : [];
  const values = {
    name: input.name,
    code,
    customerGroupId: input.customerGroupId ?? null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    priority: input.priority ?? 0,
    isActive: input.isActive ?? true,
    notes: input.notes ?? null,
    updatedBy: ctx.auth.userId,
  };
  const saved = doc
    ? await doc.update(values, { transaction: t })
    : await PriceList.create(
        { ...values, companyId: ctx.auth.companyId, createdBy: ctx.auth.userId },
        { transaction: t },
      );
  await PriceListItem.destroy({ where: { priceListId: saved.id }, transaction: t });
  await PriceListItem.bulkCreate(
    input.items.map((item, i) => ({
      priceListId: saved.id,
      productId: lines[i].productId,
      variantId: lines[i].variantId,
      unitId: item.unitId ?? null,
      price: item.price != null ? fixed(item.price) : null,
      discountPercent: item.price == null ? fixed(item.discountPercent ?? 0) : null,
      minQuantity: fixed(item.minQuantity || 0),
    })),
    { transaction: t },
  );
  return saved;
}

export async function createPriceList(ctx, input) {
  const doc = await sequelize.transaction((t) => write(ctx, null, input, t));
  return getPriceList(ctx, doc.id);
}

export async function updatePriceList(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await PriceList.findOne({
      where: { id, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!doc) throw AppError.notFound(`${LABEL} not found`);
    await write(ctx, doc, input, t);
  });
  return getPriceList(ctx, id);
}

export async function deletePriceList(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await PriceList.findOne({
      where: { id, companyId: ctx.auth.companyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!doc) throw AppError.notFound(`${LABEL} not found`);
    await doc.update(
      { code: retiredValue(doc.code, doc.id, 30), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await doc.destroy({ transaction: t });
  });
}

/** Lists the sales forms need without settings access: tax groups, payment methods, groups, settings. */
export async function salesLookups(ctx) {
  const companyId = ctx.auth.companyId;
  const [base, groups, settings] = await Promise.all([
    purchaseLookups(ctx),
    PartyGroup.findAll({
      where: { companyId, type: 'customer', isActive: true },
      attributes: ['id', 'name', 'code'],
      order: [['name', 'ASC']],
    }),
    salesSettings(companyId),
  ]);
  return {
    taxGroups: base.taxGroups,
    paymentMethods: base.paymentMethods,
    customerGroups: groups.map((g) => ({ id: String(g.id), name: g.name, code: g.code })),
    settings,
  };
}
