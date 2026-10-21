import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { ManufacturingOrder, Product, ProductVariant, Unit } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createRequisition } from '../purchase/requisitions.service.js';
import { D, fixed } from '../purchase/purchase.common.js';
import { bomFor, defaultBoms, keyOf } from './bom.service.js';
import { createOrderDraft, getOrder } from './orders.service.js';

/**
 * Material requirements planning over the open manufacturing orders (draft → in progress):
 *   demand        what the orders still need (required − issued + returned)
 *   on hand       stock in the branch's warehouses (or one warehouse)
 *   on order      open purchase orders not yet received
 *   requested     open purchase requisitions (draft / pending / approved)
 *   in production open orders making the item (sub-assemblies)
 *   shortage      demand − all of the above (never negative)
 * Bought items are suggested for a purchase requisition; items with a BOM for a sub-assembly order.
 */

const OPEN = ['draft', 'confirmed', 'material_issued', 'in_progress'];
const BRANCHES = (ctx) => (ctx.branchIds.length ? ctx.branchIds : [0]);

const sumBy = (rows) => new Map(rows.map((r) => [keyOf(r.productId, r.variantId || null), D(r.qty)]));

export async function mrp(ctx, { warehouseId, to, orderIds } = {}) {
  const companyId = ctx.auth.companyId;
  const branchIds = BRANCHES(ctx);
  const orderFilter = [
    'mo.company_id = :companyId',
    'mo.branch_id IN (:branchIds)',
    'mo.status IN (:open)',
    'mo.deleted_at IS NULL',
    ...(to ? ['mo.planned_start <= :to'] : []),
    ...(orderIds?.length ? ['mo.id IN (:orderIds)'] : []),
  ].join(' AND ');
  const replacements = { companyId, branchIds, open: OPEN, to, orderIds, warehouseId };

  const demandRows = await sequelize.query(
    `SELECT m.product_id AS productId, COALESCE(m.variant_id, 0) AS variantId,
            SUM(GREATEST(m.required_quantity - (m.issued_quantity - m.returned_quantity), 0)) AS qty,
            GROUP_CONCAT(DISTINCT mo.number ORDER BY mo.planned_start SEPARATOR ', ') AS orders,
            MIN(mo.planned_start) AS needBy
       FROM mo_materials m JOIN manufacturing_orders mo ON mo.id = m.order_id
      WHERE ${orderFilter}
      GROUP BY m.product_id, COALESCE(m.variant_id, 0)
     HAVING qty > 0`,
    { replacements, type: QueryTypes.SELECT },
  );
  if (!demandRows.length) return { rows: [], summary: { items: 0, shortages: 0, orders: 0 } };
  const productIds = [...new Set(demandRows.map((r) => r.productId))];
  const scoped = { ...replacements, productIds };

  const [onHand, onOrder, requested, making, products, variants, boms, orderCount] = await Promise.all([
    sequelize.query(
      `SELECT b.product_id AS productId, COALESCE(b.variant_id, 0) AS variantId, SUM(b.quantity) AS qty
         FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.company_id = :companyId AND b.product_id IN (:productIds) AND w.deleted_at IS NULL
          AND ${warehouseId ? 'b.warehouse_id = :warehouseId' : 'w.branch_id IN (:branchIds)'}
        GROUP BY b.product_id, COALESCE(b.variant_id, 0)`,
      { replacements: scoped, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT i.product_id AS productId, COALESCE(i.variant_id, 0) AS variantId,
              SUM(GREATEST(i.base_quantity - i.received_base_quantity, 0)) AS qty
         FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.order_id
        WHERE po.company_id = :companyId AND po.branch_id IN (:branchIds) AND po.deleted_at IS NULL
          AND po.status IN ('pending_approval', 'approved', 'partially_received') AND i.product_id IN (:productIds)
        GROUP BY i.product_id, COALESCE(i.variant_id, 0)`,
      { replacements: scoped, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT i.product_id AS productId, COALESCE(i.variant_id, 0) AS variantId, SUM(i.base_quantity) AS qty
         FROM purchase_requisition_items i JOIN purchase_requisitions r ON r.id = i.requisition_id
        WHERE r.company_id = :companyId AND r.branch_id IN (:branchIds) AND r.deleted_at IS NULL
          AND r.status IN ('draft', 'pending_approval', 'approved') AND i.product_id IN (:productIds)
        GROUP BY i.product_id, COALESCE(i.variant_id, 0)`,
      { replacements: scoped, type: QueryTypes.SELECT },
    ),
    sequelize.query(
      `SELECT mo.product_id AS productId, COALESCE(mo.variant_id, 0) AS variantId,
              SUM(GREATEST(mo.quantity - mo.good_quantity, 0)) AS qty
         FROM manufacturing_orders mo
        WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
          AND mo.status IN ('draft', 'confirmed', 'material_issued', 'in_progress', 'quality_check')
          AND mo.product_id IN (:productIds)
        GROUP BY mo.product_id, COALESCE(mo.variant_id, 0)`,
      { replacements: scoped, type: QueryTypes.SELECT },
    ),
    Product.findAll({
      where: { id: productIds, companyId },
      attributes: ['id', 'name', 'sku', 'type', 'purchasePrice', 'baseUnitId'],
      include: [{ model: Unit, as: 'baseUnit', attributes: ['id', 'code'] }],
      paranoid: false,
    }),
    ProductVariant.findAll({
      where: { productId: productIds, companyId },
      attributes: ['id', 'name'],
      paranoid: false,
    }),
    defaultBoms(companyId),
    ManufacturingOrder.count({
      where: {
        companyId,
        branchId: { [Op.in]: branchIds },
        status: { [Op.in]: OPEN },
        ...(to && { plannedStart: { [Op.lte]: to } }),
        ...(orderIds?.length && { id: { [Op.in]: orderIds } }),
      },
    }),
  ]);
  const maps = {
    onHand: sumBy(onHand),
    onOrder: sumBy(onOrder),
    requested: sumBy(requested),
    making: sumBy(making),
  };
  const productOf = new Map(products.map((p) => [String(p.id), p]));
  const variantOf = new Map(variants.map((v) => [String(v.id), v]));

  const rows = demandRows.map((r) => {
    const variantId = Number(r.variantId) ? String(r.variantId) : null;
    const key = keyOf(r.productId, variantId);
    const demand = D(r.qty);
    const get = (m) => maps[m].get(key) ?? D(0);
    const supply = nonNegative(get('onHand')).plus(get('onOrder')).plus(get('requested')).plus(get('making'));
    const shortage = demand.minus(supply);
    const p = productOf.get(String(r.productId));
    const bom = bomFor(boms, r.productId, variantId);
    return {
      productId: String(r.productId),
      variantId,
      name: p?.name,
      variantName: variantId ? variantOf.get(variantId)?.name : null,
      sku: p?.sku,
      unit: p?.baseUnit?.code ?? null,
      demand: fixed(demand),
      onHand: fixed(get('onHand')),
      onOrder: fixed(get('onOrder')),
      requested: fixed(get('requested')),
      inProduction: fixed(get('making')),
      shortage: fixed(shortage.gt(0) ? shortage : 0),
      action: bom ? 'make' : 'buy',
      bomId: bom ? String(bom.id) : null,
      estimatedCost: fixed(D(p?.purchasePrice ?? 0).times(shortage.gt(0) ? shortage : 0)),
      needBy: r.needBy,
      orders: r.orders,
    };
  });
  rows.sort(
    (a, b) => Number(D(b.shortage).gt(0)) - Number(D(a.shortage).gt(0)) || a.name.localeCompare(b.name),
  );
  return {
    rows,
    summary: {
      items: rows.length,
      shortages: rows.filter((r) => D(r.shortage).gt(0)).length,
      orders: orderCount,
      estimatedCost: fixed(rows.reduce((s, r) => s.plus(r.estimatedCost), D(0))),
    },
  };
}

/** Negative stock is not supply. */
function nonNegative(d) {
  return d.gt(0) ? d : D(0);
}

/** A draft purchase requisition for the chosen shortages (the buyer reviews and submits it). */
export async function requisitionFromMrp(ctx, { warehouseId, requiredBy, lines }) {
  const items = lines.filter((l) => D(l.quantity).gt(0));
  if (!items.length) throw AppError.unprocessable('Choose at least one item to request');
  return createRequisition(ctx, {
    warehouseId: warehouseId ?? null,
    requiredBy: requiredBy ?? null,
    notes: 'Raised from material requirements planning (MRP).',
    items: items.map((l) => ({
      productId: l.productId,
      variantId: l.variantId ?? null,
      unitId: null,
      quantity: l.quantity,
    })),
  });
}

/** Draft orders for sub-assemblies (each with its default BOM), optionally under a parent order. */
export async function subAssemblyOrders(ctx, { rawWarehouseId, parentId, plannedStart, lines }) {
  const ids = await sequelize.transaction(async (t) => {
    const boms = await defaultBoms(ctx.auth.companyId, t);
    let parent = null;
    if (parentId) {
      parent = await ManufacturingOrder.findOne({
        where: { id: parentId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!parent) throw AppError.notFound('Parent order not found');
    }
    const created = [];
    for (const [i, l] of lines.entries()) {
      const bom = bomFor(boms, l.productId, l.variantId ?? null);
      if (!bom)
        throw AppError.unprocessable('This item has no active bill of materials', [
          { field: `lines.${i}.productId`, message: 'No active BOM' },
        ]);
      const doc = await createOrderDraft(
        ctx,
        {
          productId: l.productId,
          variantId: l.variantId ?? null,
          bomId: bom.id,
          quantity: l.quantity,
          rawWarehouseId: rawWarehouseId ?? parent?.rawWarehouseId,
          finishedWarehouseId: rawWarehouseId ?? parent?.rawWarehouseId,
          plannedStart,
          parentId: parent?.id ?? null,
          priority: parent?.priority ?? 'normal',
          notes: parent ? `Sub-assembly for ${parent.number}` : 'Raised from MRP',
        },
        t,
      );
      created.push(doc.id);
    }
    return created;
  });
  return Promise.all(ids.map((id) => getOrder(ctx, id)));
}
