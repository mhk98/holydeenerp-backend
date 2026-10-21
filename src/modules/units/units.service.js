import Decimal from 'decimal.js';
import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Unit, UnitConversion } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { parseListQuery } from '../../utils/pagination.js';
import { DOCUMENT_LINE_TABLES, assertUnused } from '../../utils/usage.js';

export const unitCrud = createCrudService({
  model: Unit,
  label: 'Unit',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'code', 'category', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['category', 'isActive'],
    defaultSort: 'name',
  },
  beforeDelete: async (ctx, unit, t) => {
    await assertUnused(
      unit.id,
      [
        { table: 'products', column: 'base_unit_id', label: 'product', paranoid: true },
        {
          table: 'product_units',
          column: 'unit_id',
          label: 'product',
          where: 'product_id IN (SELECT id FROM products WHERE deleted_at IS NULL)',
        },
        { table: 'price_list_items', column: 'unit_id', label: 'price list line' },
        ...DOCUMENT_LINE_TABLES.map((table) => ({ table, column: 'unit_id', label: 'document line' })),
      ],
      { what: `Unit ${unit.name}`, transaction: t },
    );
    // Its conversions go with it.
    await UnitConversion.destroy({
      where: { companyId: ctx.auth.companyId, [Op.or]: [{ fromUnitId: unit.id }, { toUnitId: unit.id }] },
      transaction: t,
      force: true,
    });
  },
});

const conversionInclude = () => [
  { model: Unit, as: 'fromUnit', attributes: ['id', 'name', 'code'] },
  { model: Unit, as: 'toUnit', attributes: ['id', 'name', 'code'] },
];

export async function listConversions(ctx, query) {
  const q = parseListQuery(query, { sortable: ['createdAt'], defaultSort: '-createdAt' });
  const where = { companyId: ctx.auth.companyId };
  if (query.unitId) where[Op.or] = [{ fromUnitId: query.unitId }, { toUnitId: query.unitId }];
  const { rows, count } = await UnitConversion.findAndCountAll({
    where,
    include: conversionInclude(),
    order: q.order,
    limit: q.limit,
    offset: q.offset,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

export async function createConversion(ctx, { fromUnitId, toUnitId, factor }) {
  if (String(fromUnitId) === String(toUnitId)) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'toUnitId', message: 'Choose two different units' },
    ]);
  }
  const units = await Unit.count({ where: { id: [fromUnitId, toUnitId], companyId: ctx.auth.companyId } });
  if (units !== 2)
    throw AppError.unprocessable('Validation failed', [{ field: 'fromUnitId', message: 'Unit not found' }]);

  const conversion = await sequelize.transaction(async (t) => {
    // Either direction counts as the same pair (1 box = 12 pcs ⇔ 1 pcs = 1/12 box).
    const exists = await UnitConversion.count({
      where: {
        companyId: ctx.auth.companyId,
        [Op.or]: [
          { fromUnitId, toUnitId },
          { fromUnitId: toUnitId, toUnitId: fromUnitId },
        ],
      },
      transaction: t,
    });
    if (exists) throw AppError.conflict('A conversion between these units already exists');
    return UnitConversion.create(
      {
        companyId: ctx.auth.companyId,
        fromUnitId,
        toUnitId,
        factor,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return (await UnitConversion.findByPk(conversion.id, { include: conversionInclude() })).toJSON();
}

export async function deleteConversion(ctx, id) {
  const deleted = await UnitConversion.destroy({ where: { id, companyId: ctx.auth.companyId }, force: true });
  if (!deleted) throw AppError.notFound('Conversion not found');
}

/** Convert a quantity between two units using a direct or inverse conversion (string in/out). */
export async function convertQuantity(companyId, quantity, fromUnitId, toUnitId, decimals = 4) {
  if (String(fromUnitId) === String(toUnitId)) return new Decimal(quantity).toFixed(decimals);
  const conv = await UnitConversion.findOne({
    where: {
      companyId,
      [Op.or]: [
        { fromUnitId, toUnitId },
        { fromUnitId: toUnitId, toUnitId: fromUnitId },
      ],
    },
  });
  if (!conv) throw AppError.badRequest('No conversion defined between these units');
  const qty = new Decimal(quantity);
  const result =
    String(conv.fromUnitId) === String(fromUnitId) ? qty.times(conv.factor) : qty.dividedBy(conv.factor);
  return result.toFixed(decimals);
}
