import { fn, col, Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Product, ProductCategory } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

async function assertParent(ctx, parentId, selfId, t) {
  if (!parentId) return;
  const parent = await ProductCategory.findOne({
    where: { id: parentId, companyId: ctx.auth.companyId },
    transaction: t,
  });
  if (!parent)
    throw AppError.unprocessable('Validation failed', [
      { field: 'parentId', message: 'Parent category not found' },
    ]);
  if (!selfId) return;
  // Walk up from the new parent; reaching ourselves would create a cycle.
  let cursor = parent;
  while (cursor) {
    if (String(cursor.id) === String(selfId)) {
      throw AppError.unprocessable('Validation failed', [
        { field: 'parentId', message: 'A category cannot be moved under itself or its own sub-category' },
      ]);
    }
    cursor = cursor.parentId ? await ProductCategory.findByPk(cursor.parentId, { transaction: t }) : null;
  }
}

export const categoryCrud = createCrudService({
  model: ProductCategory,
  label: 'Category',
  uniqueFields: ['code'],
  include: () => [{ model: ProductCategory, as: 'parent', attributes: ['id', 'name', 'code'] }],
  listOptions: {
    sortable: ['name', 'code', 'sortOrder', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['parentId', 'isActive'],
    defaultSort: 'name',
  },
  beforeSave: async (ctx, data, existing, t) => {
    if (data.code) data.code = data.code.toUpperCase();
    if (data.parentId !== undefined) await assertParent(ctx, data.parentId, existing?.id, t);
    return data;
  },
  beforeDelete: async (ctx, category, t) => {
    const [children, products] = await Promise.all([
      ProductCategory.count({ where: { parentId: category.id }, transaction: t }),
      Product.count({ where: { categoryId: category.id }, transaction: t }),
    ]);
    if (children || products) {
      throw AppError.conflict(
        `This category has ${children} sub-categor${children === 1 ? 'y' : 'ies'} and ${products} product(s). Move them first.`,
      );
    }
  },
});

/** Whole tree (company-wide) with product counts, children ordered by sortOrder then name. */
export async function categoryTree(ctx) {
  const [rows, counts] = await Promise.all([
    ProductCategory.findAll({
      where: { companyId: ctx.auth.companyId },
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    Product.findAll({
      where: { companyId: ctx.auth.companyId, categoryId: { [Op.ne]: null } },
      attributes: ['categoryId', [fn('COUNT', col('id')), 'total']],
      group: ['categoryId'],
      raw: true,
    }),
  ]);
  const productCount = Object.fromEntries(counts.map((c) => [String(c.categoryId), Number(c.total)]));
  const nodes = new Map(
    rows.map((r) => [
      String(r.id),
      {
        ...r.toJSON(),
        id: String(r.id),
        parentId: r.parentId ? String(r.parentId) : null,
        productCount: productCount[String(r.id)] ?? 0,
        children: [],
      },
    ]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId && nodes.get(node.parentId);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/** Ids of a category and all its descendants (filter products "in Grocery" incl. sub-categories). */
export async function descendantIds(companyId, categoryId) {
  const rows = await ProductCategory.findAll({
    where: { companyId },
    attributes: ['id', 'parentId'],
    raw: true,
  });
  const ids = new Set([String(categoryId)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && ids.has(String(r.parentId)) && !ids.has(String(r.id))) {
        ids.add(String(r.id));
        grew = true;
      }
    }
  }
  return [...ids];
}

/**
 * Re-order / re-parent in one go (drag & drop): each item gets a parent and position.
 *   [{ id, parentId, sortOrder }, …]
 */
export async function moveCategories(ctx, items) {
  await sequelize.transaction(async (t) => {
    for (const item of items) {
      const category = await ProductCategory.findOne({
        where: { id: item.id, companyId: ctx.auth.companyId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!category) throw AppError.notFound('Category not found');
      await assertParent(ctx, item.parentId, category.id, t);
      await category.update(
        { parentId: item.parentId ?? null, sortOrder: item.sortOrder, updatedBy: ctx.auth.userId },
        { transaction: t },
      );
    }
  });
  return categoryTree(ctx);
}
