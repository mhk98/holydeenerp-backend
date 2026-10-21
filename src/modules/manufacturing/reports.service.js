import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { companyToday } from '../inventory/inventory.common.js';
import { D, addDays, fixed } from '../purchase/purchase.common.js';

/**
 * Manufacturing reports over a date range (completed orders by completion date; operations by
 * finish date; scrap by record date), scoped to the user's branches:
 *   production       orders completed: planned / produced / good / scrapped, std vs actual cost
 *   consumption      materials: planned (BOM incl. wastage) vs actually used, quantity and cost
 *   wastage          QC scrap by product and the wastage log by reason
 *   cost-variance    per order: material / labour / overhead standard vs actual
 *   work-centers     planned vs actual minutes against capacity (utilisation)
 */

export const REPORTS = ['production', 'consumption', 'wastage', 'cost-variance', 'work-centers'];
const MAX_ROWS = 2000;

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const pct = (part, whole) => (D(whole).isZero() ? null : fixed(D(part).dividedBy(whole).times(100), 2));
const sumOf = (rows, field) => fixed(rows.reduce((s, r) => s.plus(r[field] ?? 0), D(0)));

async function range(ctx, query) {
  const to = query.to ?? (await companyToday(ctx.auth.companyId));
  const from = query.from ?? addDays(to, -29);
  if (from > to)
    throw AppError.unprocessable('The start is after the end', [{ field: 'from', message: 'After the end' }]);
  return { from, to };
}

const base = (ctx, { from, to }) => ({
  companyId: ctx.auth.companyId,
  branchIds: ctx.branchIds.length ? ctx.branchIds : [0],
  from,
  to,
  // DATETIME columns: the whole of the last day.
  toEnd: `${to} 23:59:59`,
});

/** Completed / closed orders: output and cost against standard. */
async function production(r) {
  const rows = await select(
    `SELECT mo.id, mo.number, mo.status, p.name AS product, v.name AS variant, mo.quantity,
            mo.produced_quantity AS produced, mo.good_quantity AS good, mo.scrapped_quantity AS scrapped,
            mo.std_material_cost + mo.std_labour_cost + mo.std_overhead_cost AS standardCost,
            mo.material_cost + mo.labour_cost + mo.overhead_cost AS actualCost,
            mo.output_cost AS outputCost, mo.unit_cost AS unitCost, mo.variance_cost AS variance,
            DATE(mo.completed_at) AS completedOn
       FROM manufacturing_orders mo
       JOIN products p ON p.id = mo.product_id
       LEFT JOIN product_variants v ON v.id = mo.variant_id
      WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
        AND mo.status IN ('completed', 'closed') AND mo.completed_at BETWEEN :from AND :toEnd
      ORDER BY mo.completed_at DESC LIMIT ${MAX_ROWS}`,
    r,
  );
  for (const row of rows) {
    row.yieldPercent = pct(row.good, row.quantity);
    row.costDifference = fixed(D(row.actualCost).minus(row.standardCost));
  }
  return {
    rows,
    summary: {
      orders: rows.length,
      quantity: sumOf(rows, 'quantity'),
      good: sumOf(rows, 'good'),
      scrapped: sumOf(rows, 'scrapped'),
      standardCost: sumOf(rows, 'standardCost'),
      actualCost: sumOf(rows, 'actualCost'),
      outputCost: sumOf(rows, 'outputCost'),
      yieldPercent: pct(sumOf(rows, 'good'), sumOf(rows, 'quantity')),
    },
  };
}

/** Materials used by orders completed in the range: planned vs actual. */
async function consumption(r) {
  const rows = await select(
    `SELECT m.product_id AS productId, p.name AS product, v.name AS variant, p.sku, u.code AS unit,
            SUM(m.required_quantity) AS planned,
            SUM(m.issued_quantity - m.returned_quantity) AS used,
            SUM(m.cost) AS cost, COUNT(DISTINCT m.order_id) AS orders
       FROM mo_materials m
       JOIN manufacturing_orders mo ON mo.id = m.order_id
       JOIN products p ON p.id = m.product_id
       LEFT JOIN product_variants v ON v.id = m.variant_id
       LEFT JOIN units u ON u.id = p.base_unit_id
      WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
        AND mo.status IN ('completed', 'closed') AND mo.completed_at BETWEEN :from AND :toEnd
      GROUP BY m.product_id, m.variant_id, p.name, v.name, p.sku, u.code
      ORDER BY cost DESC LIMIT ${MAX_ROWS}`,
    r,
  );
  for (const row of rows) {
    row.difference = fixed(D(row.used).minus(row.planned));
    row.differencePercent = pct(row.difference, row.planned);
    row.unitCost = D(row.used).gt(0) ? fixed(D(row.cost).dividedBy(row.used)) : '0.0000';
  }
  return { rows, summary: { items: rows.length, cost: sumOf(rows, 'cost') } };
}

/** Units failed at QC (scrapped) per product, and the wastage log per reason. */
async function wastage(r) {
  const rows = await select(
    `SELECT p.name AS product, v.name AS variant, SUM(mo.scrapped_quantity) AS scrapped,
            SUM(mo.produced_quantity) AS produced,
            SUM(CASE WHEN mo.produced_quantity > 0
                     THEN (mo.material_cost + mo.labour_cost + mo.overhead_cost) * mo.scrapped_quantity / mo.produced_quantity
                     ELSE 0 END) AS scrapCost,
            COUNT(*) AS orders
       FROM manufacturing_orders mo
       JOIN products p ON p.id = mo.product_id
       LEFT JOIN product_variants v ON v.id = mo.variant_id
      WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
        AND mo.status IN ('completed', 'closed') AND mo.completed_at BETWEEN :from AND :toEnd
        AND mo.scrapped_quantity > 0
      GROUP BY mo.product_id, mo.variant_id, p.name, v.name
      ORDER BY scrapCost DESC LIMIT ${MAX_ROWS}`,
    r,
  );
  for (const row of rows) row.scrapPercent = pct(row.scrapped, row.produced);
  const log = await select(
    `SELECT s.reason, p.name AS product, v.name AS variant, SUM(s.quantity) AS quantity, SUM(s.cost) AS cost,
            COUNT(*) AS entries
       FROM mo_scrap s
       JOIN manufacturing_orders mo ON mo.id = s.order_id
       JOIN products p ON p.id = s.product_id
       LEFT JOIN product_variants v ON v.id = s.variant_id
      WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
        AND s.created_at BETWEEN :from AND :toEnd
      GROUP BY s.reason, s.product_id, s.variant_id, p.name, v.name
      ORDER BY cost DESC LIMIT ${MAX_ROWS}`,
    r,
  );
  return {
    rows,
    log,
    summary: {
      scrapped: sumOf(rows, 'scrapped'),
      scrapCost: sumOf(rows, 'scrapCost'),
      loggedCost: sumOf(log, 'cost'),
    },
  };
}

/** Per order: each cost element, standard vs actual. */
async function costVariance(r) {
  const rows = await select(
    `SELECT mo.id, mo.number, p.name AS product, v.name AS variant, mo.good_quantity AS good,
            mo.std_material_cost AS stdMaterial, mo.material_cost AS material,
            mo.std_labour_cost AS stdLabour, mo.labour_cost AS labour,
            mo.std_overhead_cost AS stdOverhead, mo.overhead_cost AS overhead
       FROM manufacturing_orders mo
       JOIN products p ON p.id = mo.product_id
       LEFT JOIN product_variants v ON v.id = mo.variant_id
      WHERE mo.company_id = :companyId AND mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL
        AND mo.status IN ('completed', 'closed') AND mo.completed_at BETWEEN :from AND :toEnd
      ORDER BY mo.completed_at DESC LIMIT ${MAX_ROWS}`,
    r,
  );
  for (const row of rows) {
    row.materialVariance = fixed(D(row.material).minus(row.stdMaterial));
    row.labourVariance = fixed(D(row.labour).minus(row.stdLabour));
    row.overheadVariance = fixed(D(row.overhead).minus(row.stdOverhead));
    row.totalVariance = fixed(D(row.materialVariance).plus(row.labourVariance).plus(row.overheadVariance));
  }
  return {
    rows,
    summary: {
      orders: rows.length,
      materialVariance: sumOf(rows, 'materialVariance'),
      labourVariance: sumOf(rows, 'labourVariance'),
      overheadVariance: sumOf(rows, 'overheadVariance'),
      totalVariance: sumOf(rows, 'totalVariance'),
    },
  };
}

/** Work-center load: operations finished in the range against capacity (working days × hours). */
async function workCenters(r) {
  const rows = await select(
    `SELECT w.id, w.code, w.name, w.capacity_hours AS capacityHours,
            COALESCE(SUM(o.planned_minutes), 0) AS plannedMinutes,
            COALESCE(SUM(o.actual_minutes), 0) AS actualMinutes,
            COALESCE(SUM(o.labour_cost + o.overhead_cost), 0) AS cost,
            COUNT(o.id) AS operations
       FROM work_centers w
       LEFT JOIN mo_operations o ON o.work_center_id = w.id AND o.status = 'done'
            AND o.finished_at BETWEEN :from AND :toEnd
       LEFT JOIN manufacturing_orders mo ON mo.id = o.order_id
      WHERE w.company_id = :companyId AND w.deleted_at IS NULL
        AND (o.id IS NULL OR (mo.branch_id IN (:branchIds) AND mo.deleted_at IS NULL))
      GROUP BY w.id, w.code, w.name, w.capacity_hours
      ORDER BY w.code`,
    r,
  );
  const days = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
  for (const row of rows) {
    row.capacityMinutes = fixed(D(row.capacityHours).times(60).times(days), 2);
    row.utilisationPercent = pct(row.actualMinutes, row.capacityMinutes);
    row.efficiencyPercent = pct(row.plannedMinutes, row.actualMinutes);
  }
  return {
    rows,
    summary: {
      days,
      operations: rows.reduce((s, x) => s + Number(x.operations), 0),
      cost: sumOf(rows, 'cost'),
    },
  };
}

const BUILD = {
  production,
  consumption,
  wastage,
  'cost-variance': costVariance,
  'work-centers': workCenters,
};

export async function manufacturingReport(ctx, name, query) {
  const build = BUILD[name];
  if (!build) throw AppError.notFound('Report not found');
  const dates = await range(ctx, query);
  return { ...dates, ...(await build(base(ctx, dates))) };
}
