import { Op } from 'sequelize';
import { ProductAttribute, ProductAttributeValue, ProductVariantValue } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

const include = () => [
  { model: ProductAttributeValue, as: 'values', attributes: ['id', 'value', 'sortOrder'] },
];

const serialize = (a) => {
  const json = a.toJSON();
  return { ...json, values: [...(json.values ?? [])].sort((x, y) => x.sortOrder - y.sortOrder) };
};

/**
 * Sync values by text: keep existing ids for unchanged values (variants reference them),
 * add new ones, and refuse to drop values that variants still use.
 */
async function syncValues(attributeId, values, t) {
  const existing = await ProductAttributeValue.findAll({ where: { attributeId }, transaction: t });
  const byValue = new Map(existing.map((v) => [v.value.toLowerCase(), v]));
  const keep = new Set();

  for (const [i, value] of values.entries()) {
    const found = byValue.get(value.toLowerCase());
    if (found) {
      keep.add(String(found.id));
      await found.update({ value, sortOrder: i }, { transaction: t });
    } else {
      const created = await ProductAttributeValue.create(
        { attributeId, value, sortOrder: i },
        { transaction: t },
      );
      keep.add(String(created.id));
    }
  }

  const removed = existing.filter((v) => !keep.has(String(v.id)));
  if (removed.length) {
    const used = await ProductVariantValue.count({
      where: { attributeValueId: { [Op.in]: removed.map((v) => v.id) } },
      transaction: t,
    });
    if (used) {
      throw AppError.conflict(
        `Can't remove ${removed.map((v) => v.value).join(', ')}: product variants use them.`,
        [{ field: 'values', message: 'Some removed values are used by variants' }],
      );
    }
    await ProductAttributeValue.destroy({ where: { id: removed.map((v) => v.id) }, transaction: t });
  }
}

export const attributeCrud = createCrudService({
  model: ProductAttribute,
  label: 'Attribute',
  include,
  serialize,
  listOptions: {
    sortable: ['name', 'sortOrder', 'createdAt'],
    searchable: ['name'],
    defaultSort: 'sortOrder',
  },
  beforeSave: async (ctx, data, existing, t) => {
    if (data.name) {
      const clash = await ProductAttribute.count({
        where: {
          companyId: ctx.auth.companyId,
          name: data.name,
          ...(existing && { id: { [Op.ne]: existing.id } }),
        },
        transaction: t,
      });
      if (clash)
        throw AppError.conflict('Attribute already exists', [{ field: 'name', message: 'Already exists' }]);
    }
    return data;
  },
  afterSave: async (ctx, attribute, data, t) => {
    if (data.values) await syncValues(attribute.id, data.values, t);
  },
  beforeDelete: async (ctx, attribute, t) => {
    const values = await ProductAttributeValue.findAll({
      where: { attributeId: attribute.id },
      attributes: ['id'],
      transaction: t,
    });
    const used = values.length
      ? await ProductVariantValue.count({
          where: { attributeValueId: values.map((v) => v.id) },
          transaction: t,
        })
      : 0;
    if (used) throw AppError.conflict('Product variants use this attribute');
  },
});
