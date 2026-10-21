import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Bom,
  BomByproduct,
  BomComponent,
  BomOperation,
  BomQualityCheck,
  Product,
  ProductVariant,
  Unit,
  User,
  WorkCenter,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertUnused } from '../../utils/usage.js';
import { invalid, normalizeLines } from '../inventory/inventory.common.js';
import { D, fixed } from '../purchase/purchase.common.js';

/**
 * Work centers and bills of materials.
 *
 * A BOM says what makes `quantity` (base unit) of a product: components (with wastage %), by-products
 * (with their share of the cost), routing operations on work centers and quality checkpoints. A
 * component that has its own active BOM is a sub-assembly, which makes BOMs multi-level.
 *   draft ─activate─▶ active ─archive─▶ archived      (active BOMs are not edited: copy a new version)
 * One active BOM per product is the default used by manufacturing orders and MRP.
 */

// ── Work centers ──────────────────────────────────────────────────────────

export const workCenters = createCrudService({
  model: WorkCenter,
  label: 'Work center',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['code', 'name', 'createdAt'],
    searchable: ['code', 'name'],
    filterable: ['isActive', 'branchId'],
    defaultSort: 'code',
  },
  beforeSave: async (ctx, data) => {
    if (data.code) data.code = data.code.toUpperCase();
    return data;
  },
  beforeDelete: (ctx, wc, t) =>
    assertUnused(
      wc.id,
      [
        { table: 'bom_operations', column: 'work_center_id', label: 'BOM operation' },
        { table: 'mo_operations', column: 'work_center_id', label: 'order operation' },
      ],
      { what: `Work center ${wc.name}`, transaction: t },
    ),
});

// ── Costs ─────────────────────────────────────────────────────────────────

/** Standard unit cost of products that are bought: purchase price, else the current average cost. */
async function boughtUnitCosts(companyId, keys, t) {
  if (!keys.length) return new Map();
  const productIds = [...new Set(keys.map((k) => k.split(':')[0]))];
  const [products, variants, averages] = await Promise.all([
    Product.findAll({
      where: { id: productIds, companyId },
      attributes: ['id', 'purchasePrice'],
      transaction: t,
    }),
    ProductVariant.findAll({
      where: { productId: productIds, companyId },
      attributes: ['id', 'productId', 'purchasePrice'],
      transaction: t,
    }),
    sequelize.query(
      `SELECT product_id AS productId, COALESCE(variant_id, 0) AS variantId,
              SUM(total_value) / NULLIF(SUM(quantity), 0) AS avgCost
         FROM stock_balances WHERE company_id = :companyId AND product_id IN (:productIds) AND quantity > 0
        GROUP BY product_id, COALESCE(variant_id, 0)`,
      { replacements: { companyId, productIds }, type: QueryTypes.SELECT, transaction: t },
    ),
  ]);
  // A zero price means "not set": fall back to the average cost in stock.
  const set = (v) => (v != null && D(v).gt(0) ? v : null);
  const price = new Map(products.map((p) => [`${p.id}:0`, set(p.purchasePrice)]));
  for (const v of variants)
    price.set(`${v.productId}:${v.id}`, set(v.purchasePrice) ?? price.get(`${v.productId}:0`));
  const avg = new Map(averages.map((a) => [`${a.productId}:${a.variantId}`, a.avgCost]));
  return new Map(keys.map((k) => [k, D(price.get(k) ?? avg.get(k) ?? avg.get(`${k.split(':')[0]}:0`) ?? 0)]));
}

const keyOf = (productId, variantId) => `${productId}:${variantId ?? 0}`;

/** The default active BOM of each product (key "productId:variantId"), for sub-assemblies. */
async function defaultBoms(companyId, t) {
  const rows = await Bom.findAll({
    where: { companyId, status: 'active', isDefault: true },
    include: [
      { model: BomComponent, as: 'components' },
      { model: BomByproduct, as: 'byproducts' },
      {
        model: BomOperation,
        as: 'operations',
        include: [{ model: WorkCenter, as: 'workCenter', paranoid: false }],
      },
    ],
    transaction: t,
  });
  const map = new Map();
  for (const b of rows) {
    map.set(keyOf(b.productId, b.variantId), b);
    // A product BOM also covers its variants that have none of their own.
    if (b.variantId == null) map.set(`${b.productId}:*`, b);
  }
  return map;
}
const bomFor = (boms, productId, variantId) =>
  boms.get(keyOf(productId, variantId)) ?? (variantId ? boms.get(`${productId}:*`) : undefined);

/**
 * Standard cost of making `quantity` (base unit) with a BOM: materials (sub-assemblies rolled up
 * through their own BOMs), labour and overhead from the routing. By-products take their cost share.
 */
export async function standardCost(companyId, bom, quantity, t, ctx = {}) {
  const boms = ctx.boms ?? (await defaultBoms(companyId, t));
  const seen = ctx.seen ?? new Set();
  if (seen.has(String(bom.id))) throw AppError.unprocessable(`BOM ${bom.code} contains itself`);
  const factor = D(quantity).dividedBy(bom.quantity);
  const components =
    bom.components ?? (await BomComponent.findAll({ where: { bomId: bom.id }, transaction: t }));
  const operations =
    bom.operations ??
    (await BomOperation.findAll({
      where: { bomId: bom.id },
      include: [{ model: WorkCenter, as: 'workCenter', paranoid: false }],
      transaction: t,
    }));
  const byproducts =
    bom.byproducts ?? (await BomByproduct.findAll({ where: { bomId: bom.id }, transaction: t }));
  const bought = await boughtUnitCosts(
    companyId,
    components
      .filter((c) => !bomFor(boms, c.productId, c.variantId))
      .map((c) => keyOf(c.productId, c.variantId)),
    t,
  );

  let material = D(0);
  const lines = [];
  for (const c of components) {
    const qty = D(c.baseQuantity)
      .times(D(1).plus(D(c.wastagePercent).dividedBy(100)))
      .times(factor);
    const sub = bomFor(boms, c.productId, c.variantId);
    let unit;
    if (sub) {
      const cost = await standardCost(companyId, sub, sub.quantity, t, {
        boms,
        seen: new Set([...seen, String(bom.id)]),
      });
      unit = D(cost.unitCost);
    } else {
      unit = bought.get(keyOf(c.productId, c.variantId)) ?? D(0);
    }
    material = material.plus(qty.times(unit));
    lines.push({
      componentId: String(c.id),
      productId: String(c.productId),
      quantity: fixed(qty),
      unitCost: fixed(unit),
      cost: fixed(qty.times(unit)),
      subAssembly: Boolean(sub),
    });
  }
  let labour = D(0);
  let overhead = D(0);
  for (const op of operations) {
    const hours = D(op.setupMinutes).plus(D(op.runMinutes).times(factor)).dividedBy(60);
    labour = labour.plus(hours.times(op.workCenter?.labourCostPerHour ?? 0));
    overhead = overhead.plus(hours.times(op.workCenter?.overheadCostPerHour ?? 0));
  }
  const total = material.plus(labour).plus(overhead);
  const byproductShare = byproducts.reduce((s, b) => s.plus(b.costSharePercent), D(0));
  const mainCost = total.times(D(1).minus(byproductShare.dividedBy(100)));
  return {
    quantity: fixed(quantity),
    material: fixed(material),
    labour: fixed(labour),
    overhead: fixed(overhead),
    total: fixed(total),
    byproductCost: fixed(total.minus(mainCost)),
    unitCost: fixed(D(quantity).gt(0) ? mainCost.dividedBy(quantity) : 0),
    lines,
  };
}

/**
 * Everything needed to make `quantity` of a BOM, sub-assemblies exploded to the bought materials.
 * Returns { materials: Map("p:v" → base qty), subAssemblies: [{ bom, quantity, depth }] }.
 */
export async function explode(companyId, bom, quantity, t, { boms, depth = 0, seen = new Set(), out } = {}) {
  const map = boms ?? (await defaultBoms(companyId, t));
  const acc = out ?? { materials: new Map(), subAssemblies: [] };
  if (seen.has(String(bom.id))) throw AppError.unprocessable(`BOM ${bom.code} contains itself`);
  const factor = D(quantity).dividedBy(bom.quantity);
  const components =
    bom.components ?? (await BomComponent.findAll({ where: { bomId: bom.id }, transaction: t }));
  for (const c of components) {
    const qty = D(c.baseQuantity)
      .times(D(1).plus(D(c.wastagePercent).dividedBy(100)))
      .times(factor);
    const sub = bomFor(map, c.productId, c.variantId);
    if (sub) {
      acc.subAssemblies.push({
        bom: sub,
        productId: String(c.productId),
        variantId: c.variantId ? String(c.variantId) : null,
        quantity: qty,
        depth: depth + 1,
      });
      await explode(companyId, sub, qty, t, {
        boms: map,
        depth: depth + 1,
        seen: new Set([...seen, String(bom.id)]),
        out: acc,
      });
    } else {
      const k = keyOf(c.productId, c.variantId);
      acc.materials.set(k, (acc.materials.get(k) ?? D(0)).plus(qty));
    }
  }
  return acc;
}

export { defaultBoms, bomFor, keyOf };

// ── BOMs ──────────────────────────────────────────────────────────────────

const LIST_OPTIONS = {
  sortable: ['code', 'name', 'version', 'createdAt'],
  searchable: ['code', 'name'],
  filterable: ['status', 'productId', 'isDefault'],
  defaultSort: 'code',
};
const productRef = () => ({
  model: Product,
  as: 'product',
  attributes: ['id', 'name', 'sku', 'type', 'baseUnitId'],
  paranoid: false,
});
const variantRef = () => ({
  model: ProductVariant,
  as: 'variant',
  attributes: ['id', 'name', 'sku'],
  paranoid: false,
});
const full = () => [
  productRef(),
  variantRef(),
  { model: User, as: 'activator', attributes: ['id', 'name'] },
  {
    model: BomComponent,
    as: 'components',
    separate: true,
    order: [['sortOrder', 'ASC']],
    include: [productRef(), variantRef(), { model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] }],
  },
  {
    model: BomByproduct,
    as: 'byproducts',
    separate: true,
    order: [['sortOrder', 'ASC']],
    include: [productRef(), variantRef()],
  },
  {
    model: BomOperation,
    as: 'operations',
    separate: true,
    order: [['sequence', 'ASC']],
    include: [
      {
        model: WorkCenter,
        as: 'workCenter',
        attributes: ['id', 'code', 'name', 'labourCostPerHour', 'overheadCostPerHour'],
        paranoid: false,
      },
    ],
  },
  { model: BomQualityCheck, as: 'qualityChecks', separate: true, order: [['sequence', 'ASC']] },
];

export async function listBoms(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await Bom.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId },
    include: [productRef(), variantRef()],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

async function findBom(ctx, id, t, lock = false) {
  const bom = await Bom.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    ...(lock && { lock: t.LOCK.UPDATE }),
  });
  if (!bom) throw AppError.notFound('Bill of materials not found');
  return bom;
}

export async function getBom(ctx, id) {
  const bom = await Bom.findOne({ where: { id, companyId: ctx.auth.companyId }, include: full() });
  if (!bom) throw AppError.notFound('Bill of materials not found');
  const cost = await standardCost(ctx.auth.companyId, bom, bom.quantity);
  return { ...bom.toJSON(), standardCost: cost };
}

/** Validate and write the header and lines of a draft BOM. */
async function writeDraft(ctx, bom, input, t) {
  const [line] = await normalizeLines(
    ctx,
    [{ productId: input.productId, variantId: input.variantId, quantity: '1' }],
    t,
  );
  if (line.product.trackSerial)
    throw invalid('productId', 'Serial-tracked products cannot be manufactured yet');
  const items = await normalizeLines(ctx, input.items, t);
  items.forEach((c, i) => {
    if (
      String(c.productId) === String(input.productId) &&
      String(c.variantId ?? '') === String(input.variantId ?? '')
    )
      throw invalid(`items.${i}.productId`, 'A product cannot be a component of itself');
    if (c.product.trackSerial)
      throw invalid(
        `items.${i}.productId`,
        `${c.product.name} is serial-tracked; it cannot be a component yet`,
      );
  });
  const byproducts = input.byproducts?.length
    ? await normalizeLines(
        ctx,
        input.byproducts.map((b) => ({ ...b, unitId: null })),
        t,
      )
    : [];
  const share = (input.byproducts ?? []).reduce((s, b) => s.plus(b.costSharePercent ?? 0), D(0));
  if (share.gt(100)) throw invalid('byproducts', 'By-products can take at most 100% of the cost');
  const centers = input.operations?.length
    ? await WorkCenter.findAll({
        where: { id: input.operations.map((o) => o.workCenterId), companyId: ctx.auth.companyId },
        transaction: t,
      })
    : [];
  (input.operations ?? []).forEach((o, i) => {
    if (!centers.some((w) => String(w.id) === String(o.workCenterId)))
      throw invalid(`operations.${i}.workCenterId`, 'Work center not found');
  });

  await bom.update(
    {
      productId: input.productId,
      variantId: input.variantId ?? null,
      name: input.name,
      quantity: fixed(input.quantity),
      notes: input.notes ?? null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  for (const model of [BomComponent, BomByproduct, BomOperation, BomQualityCheck])
    await model.destroy({ where: { bomId: bom.id }, transaction: t });
  await BomComponent.bulkCreate(
    items.map((c, i) => ({
      bomId: bom.id,
      productId: c.productId,
      variantId: c.variantId ?? null,
      unitId: c.unitId ?? null,
      unitFactor: c.unitFactor,
      quantity: fixed(c.quantity),
      baseQuantity: fixed(c.baseQuantity),
      wastagePercent: fixed(input.items[i].wastagePercent ?? 0),
      notes: input.items[i].notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
  await BomByproduct.bulkCreate(
    byproducts.map((b, i) => ({
      bomId: bom.id,
      productId: b.productId,
      variantId: b.variantId ?? null,
      quantity: fixed(b.baseQuantity),
      costSharePercent: fixed(input.byproducts[i].costSharePercent ?? 0),
      sortOrder: i,
    })),
    { transaction: t },
  );
  await BomOperation.bulkCreate(
    (input.operations ?? []).map((o, i) => ({
      bomId: bom.id,
      sequence: o.sequence ?? (i + 1) * 10,
      name: o.name,
      workCenterId: o.workCenterId,
      setupMinutes: fixed(o.setupMinutes ?? 0, 2),
      runMinutes: fixed(o.runMinutes ?? 0, 2),
      notes: o.notes ?? null,
    })),
    { transaction: t },
  );
  await BomQualityCheck.bulkCreate(
    (input.qualityChecks ?? []).map((q, i) => ({
      bomId: bom.id,
      sequence: (i + 1) * 10,
      name: q.name,
      instructions: q.instructions ?? null,
    })),
    { transaction: t },
  );
}

async function assertCodeFree(ctx, code, exceptId, t) {
  const clash = await Bom.count({
    where: { companyId: ctx.auth.companyId, code, ...(exceptId && { id: { [Op.ne]: exceptId } }) },
    transaction: t,
  });
  if (clash) throw invalid('code', 'This code is already in use');
}

export async function createBom(ctx, input) {
  const id = await sequelize.transaction(async (t) => {
    const code = input.code.toUpperCase();
    await assertCodeFree(ctx, code, null, t);
    const bom = await Bom.create(
      {
        companyId: ctx.auth.companyId,
        productId: input.productId,
        code,
        name: input.name,
        quantity: fixed(input.quantity),
        status: 'draft',
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(ctx, bom, input, t);
    return bom.id;
  });
  return getBom(ctx, id);
}

export async function updateBom(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const bom = await findBom(ctx, id, t, true);
    if (bom.status !== 'draft')
      throw AppError.conflict('Only draft BOMs can be edited; copy a new version to change an active one');
    const code = input.code.toUpperCase();
    await assertCodeFree(ctx, code, bom.id, t);
    await bom.update({ code }, { transaction: t });
    await writeDraft(ctx, bom, input, t);
  });
  return getBom(ctx, id);
}

export async function deleteBom(ctx, id) {
  await sequelize.transaction(async (t) => {
    const bom = await findBom(ctx, id, t, true);
    if (bom.status === 'active') throw AppError.conflict('Archive the BOM before deleting it');
    await assertUnused(
      bom.id,
      [{ table: 'manufacturing_orders', column: 'bom_id', label: 'manufacturing order', paranoid: true }],
      {
        what: `BOM ${bom.code}`,
        hint: 'archive it instead',
        transaction: t,
      },
    );
    await bom.update({ code: retiredValue(bom.code, bom.id, 40) }, { transaction: t });
    await bom.destroy({ transaction: t });
  });
}

/** Activate a draft: it must have components and make sense as a tree (no loops). */
export async function activateBom(ctx, id, { makeDefault = true } = {}) {
  await sequelize.transaction(async (t) => {
    const bom = await findBom(ctx, id, t, true);
    if (bom.status !== 'draft') throw AppError.conflict(`BOM ${bom.code} is ${bom.status}`);
    if (!(await BomComponent.count({ where: { bomId: bom.id }, transaction: t })))
      throw AppError.unprocessable('Add at least one component');
    const otherDefault = await Bom.findOne({
      where: {
        companyId: ctx.auth.companyId,
        productId: bom.productId,
        variantId: bom.variantId,
        status: 'active',
        isDefault: true,
        id: { [Op.ne]: bom.id },
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const isDefault = makeDefault || !otherDefault;
    if (isDefault && otherDefault) await otherDefault.update({ isDefault: false }, { transaction: t });
    await bom.update(
      {
        status: 'active',
        isDefault,
        activatedBy: ctx.auth.userId,
        activatedAt: new Date(),
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    // A loop (A needs B needs A) shows up when exploding.
    await explode(ctx.auth.companyId, bom, bom.quantity, t);
  });
  return getBom(ctx, id);
}

export async function archiveBom(ctx, id) {
  await sequelize.transaction(async (t) => {
    const bom = await findBom(ctx, id, t, true);
    if (bom.status !== 'active') throw AppError.conflict(`BOM ${bom.code} is ${bom.status}`);
    await bom.update(
      { status: 'archived', isDefault: false, updatedBy: ctx.auth.userId },
      { transaction: t },
    );
  });
  return getBom(ctx, id);
}

/** Make an active BOM the default for its product. */
export async function setDefaultBom(ctx, id) {
  await sequelize.transaction(async (t) => {
    const bom = await findBom(ctx, id, t, true);
    if (bom.status !== 'active') throw AppError.conflict('Only an active BOM can be the default');
    await Bom.update(
      { isDefault: false },
      {
        where: {
          companyId: ctx.auth.companyId,
          productId: bom.productId,
          variantId: bom.variantId,
          id: { [Op.ne]: bom.id },
        },
        transaction: t,
      },
    );
    await bom.update({ isDefault: true, updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return getBom(ctx, id);
}

/** Copy a BOM as the next version (a draft) to change it. */
export async function newBomVersion(ctx, id) {
  const newId = await sequelize.transaction(async (t) => {
    const source = await Bom.findOne({
      where: { id, companyId: ctx.auth.companyId },
      include: full(),
      transaction: t,
    });
    if (!source) throw AppError.notFound('Bill of materials not found');
    const root = source.code.replace(/-V\d+$/, '');
    const latest = await Bom.max('version', {
      where: { companyId: ctx.auth.companyId, productId: source.productId, variantId: source.variantId },
      paranoid: false,
      transaction: t,
    });
    const version = Number(latest ?? source.version) + 1;
    const code = `${root}-V${version}`.slice(0, 40);
    await assertCodeFree(ctx, code, null, t);
    const bom = await Bom.create(
      {
        companyId: ctx.auth.companyId,
        productId: source.productId,
        variantId: source.variantId,
        code,
        name: source.name,
        version,
        quantity: source.quantity,
        status: 'draft',
        notes: source.notes,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await writeDraft(
      ctx,
      bom,
      {
        productId: source.productId,
        variantId: source.variantId,
        name: source.name,
        quantity: source.quantity,
        notes: source.notes,
        items: source.components.map((c) => ({
          productId: c.productId,
          variantId: c.variantId,
          unitId: c.unitId,
          quantity: c.quantity,
          wastagePercent: c.wastagePercent,
          notes: c.notes,
        })),
        byproducts: source.byproducts.map((b) => ({
          productId: b.productId,
          variantId: b.variantId,
          quantity: b.quantity,
          costSharePercent: b.costSharePercent,
        })),
        operations: source.operations.map((o) => ({
          sequence: o.sequence,
          name: o.name,
          workCenterId: o.workCenterId,
          setupMinutes: o.setupMinutes,
          runMinutes: o.runMinutes,
          notes: o.notes,
        })),
        qualityChecks: source.qualityChecks.map((q) => ({ name: q.name, instructions: q.instructions })),
      },
      t,
    );
    return bom.id;
  });
  return getBom(ctx, newId);
}

/** Multi-level tree of a BOM for `quantity`: each component, and sub-assemblies with their own components. */
export async function bomTree(ctx, id, quantity) {
  const companyId = ctx.auth.companyId;
  const root = await Bom.findOne({ where: { id, companyId } });
  if (!root) throw AppError.notFound('Bill of materials not found');
  const boms = await defaultBoms(companyId);
  const products = new Map(
    (
      await Product.findAll({
        where: { companyId },
        attributes: ['id', 'name', 'sku', 'type'],
        paranoid: false,
      })
    ).map((p) => [String(p.id), p]),
  );
  const build = async (bom, qty, seen) => {
    if (seen.has(String(bom.id))) throw AppError.unprocessable(`BOM ${bom.code} contains itself`);
    const factor = D(qty).dividedBy(bom.quantity);
    const components =
      bom.components ??
      (await BomComponent.findAll({ where: { bomId: bom.id }, order: [['sortOrder', 'ASC']] }));
    const children = [];
    for (const c of components) {
      const need = D(c.baseQuantity)
        .times(D(1).plus(D(c.wastagePercent).dividedBy(100)))
        .times(factor);
      const sub = bomFor(boms, c.productId, c.variantId);
      const p = products.get(String(c.productId));
      children.push({
        productId: String(c.productId),
        variantId: c.variantId ? String(c.variantId) : null,
        name: p?.name,
        sku: p?.sku,
        quantity: fixed(need),
        wastagePercent: fixed(c.wastagePercent),
        bomId: sub ? String(sub.id) : null,
        bomCode: sub?.code ?? null,
        children: sub ? await build(sub, need, new Set([...seen, String(bom.id)])) : [],
      });
    }
    return children;
  };
  const qty = quantity ?? root.quantity;
  const p = products.get(String(root.productId));
  return {
    bomId: String(root.id),
    bomCode: root.code,
    productId: String(root.productId),
    name: p?.name,
    sku: p?.sku,
    quantity: fixed(qty),
    children: await build(root, qty, new Set()),
  };
}
