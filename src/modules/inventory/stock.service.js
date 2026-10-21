import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Branch,
  Product,
  ProductUnit,
  ProductVariant,
  StockAdjustment,
  StockBatch,
  StockCount,
  StockMovement,
  StockSerial,
  StockTransfer,
  Unit,
  User,
  Warehouse,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { descendantIds } from '../categories/categories.service.js';
import { companyToday, inventorySettings, visibleWarehouseIds } from './inventory.common.js';
import { D, fixed4, isLotTracked } from './stock.engine.js';

/**
 * Read side of inventory: stock overview, stock card, ledger, batches, serials, item search,
 * alerts and reports. Everything is limited to the warehouses of the request's branches.
 */

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** page/limit for report endpoints (larger pages than CRUD lists so exports stay quick). */
function paging(query, max = 500) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(max, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}
const meta = ({ page, limit }, total) => ({ page, limit, total, totalPages: Math.ceil(total / limit) || 0 });

/** Warehouses to report on: the visible ones, or the one asked for (if visible). */
async function scopeWarehouses(ctx, warehouseId) {
  const visible = await visibleWarehouseIds(ctx);
  if (!warehouseId) return visible.length ? visible : ['0'];
  if (!visible.includes(String(warehouseId)))
    throw AppError.forbidden('You do not have access to this warehouse');
  return [String(warehouseId)];
}

const itemName = (r) => (r.variantName ? `${r.name} (${r.variantName})` : r.name);

function stockStatus(quantity, reorderLevel) {
  const q = D(quantity);
  if (q.lt(0)) return 'negative';
  if (q.isZero()) return 'out';
  if (D(reorderLevel).gt(0) && q.lte(reorderLevel)) return 'low';
  return 'in_stock';
}

function shapeStockRow(r) {
  const quantity = fixed4(r.quantity);
  const value = fixed4(r.totalValue);
  return {
    key: `${r.productId}:${r.variantId ?? ''}`,
    productId: String(r.productId),
    variantId: r.variantId ? String(r.variantId) : null,
    name: r.name,
    variantName: r.variantName ?? null,
    sku: r.variantSku ?? r.sku,
    barcode: r.variantBarcode ?? r.barcode ?? null,
    unitCode: r.unitCode,
    category: r.categoryName ?? null,
    brand: r.brandName ?? null,
    imageUrl: r.imageUrl ?? null,
    reorderLevel: fixed4(r.reorderLevel),
    trackBatch: Boolean(r.trackBatch),
    trackSerial: Boolean(r.trackSerial),
    trackExpiry: Boolean(r.trackExpiry),
    quantity,
    totalValue: value,
    avgCost: D(quantity).gt(0) ? fixed4(D(value).dividedBy(quantity)) : fixed4(r.purchasePrice),
    lastMovementAt: r.lastMovementAt ?? null,
    status: stockStatus(quantity, r.reorderLevel),
  };
}

const STOCK_SORT = {
  name: 'MAX(p.name) %, MAX(v.name) %',
  sku: 'MAX(COALESCE(v.sku, p.sku)) %',
  quantity: 'quantity %',
  value: 'totalValue %',
  reorderLevel: 'MAX(p.reorder_level) %',
};

const STATUS_HAVING = {
  in_stock: 'quantity > 0 AND (MAX(p.reorder_level) = 0 OR quantity > MAX(p.reorder_level))',
  low: 'quantity > 0 AND MAX(p.reorder_level) > 0 AND quantity <= MAX(p.reorder_level)',
  out: 'quantity <= 0',
  negative: 'quantity < 0',
  // Alert flavour: only items that are expected to be stocked.
  out_alert: 'quantity <= 0 AND (MAX(p.reorder_level) > 0 OR COUNT(b.id) > 0)',
  nonzero: 'quantity <> 0',
};

/**
 * One row per stocked item (product or variant) with its quantity and value summed over the
 * given warehouses. Items without any balance row are included at zero.
 */
async function stockRows(ctx, warehouseIds, filters = {}, { page = 1, limit = 50, sort = 'name' } = {}) {
  const replacements = { companyId: ctx.auth.companyId, warehouseIds };
  const where = [
    'p.company_id = :companyId',
    'p.deleted_at IS NULL',
    "p.type <> 'service'",
    '(p.has_variants = 0 OR v.id IS NOT NULL)',
  ];
  if (!filters.includeInactive) where.push('p.is_active = 1', '(v.id IS NULL OR v.is_active = 1)');
  if (filters.categoryId) {
    replacements.categories = await descendantIds(ctx.auth.companyId, filters.categoryId);
    where.push('p.category_id IN (:categories)');
  }
  if (filters.brandId) {
    replacements.brandId = filters.brandId;
    where.push('p.brand_id = :brandId');
  }
  if (filters.productId) {
    replacements.productId = filters.productId;
    where.push('p.id = :productId');
  }
  if (filters.search) {
    replacements.like = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    replacements.exact = filters.search;
    where.push(
      '(p.name LIKE :like OR p.sku LIKE :like OR p.barcode = :exact OR v.name LIKE :like OR v.sku LIKE :like OR v.barcode = :exact)',
    );
  }
  const having = filters.status ? `HAVING ${STATUS_HAVING[filters.status]}` : '';
  const [field, dir] = sort.startsWith('-') ? [sort.slice(1), 'DESC'] : [sort, 'ASC'];
  const order = (STOCK_SORT[field] ?? STOCK_SORT.name).replaceAll('%', dir);

  const query = (extra = '') => `
    SELECT p.id AS productId, v.id AS variantId,
           MAX(p.name) AS name, MAX(p.sku) AS sku, MAX(p.barcode) AS barcode,
           MAX(v.name) AS variantName, MAX(v.sku) AS variantSku, MAX(v.barcode) AS variantBarcode,
           MAX(u.code) AS unitCode, MAX(c.name) AS categoryName, MAX(br.name) AS brandName,
           MAX(p.reorder_level) AS reorderLevel, MAX(p.purchase_price) AS purchasePrice,
           MAX(p.track_batch) AS trackBatch, MAX(p.track_serial) AS trackSerial, MAX(p.track_expiry) AS trackExpiry,
           COALESCE(SUM(b.quantity), 0) AS quantity, COALESCE(SUM(b.total_value), 0) AS totalValue,
           MAX(b.last_movement_at) AS lastMovementAt ${extra}
      FROM products p
      LEFT JOIN product_variants v ON v.product_id = p.id AND p.has_variants = 1 AND v.deleted_at IS NULL
      LEFT JOIN stock_balances b ON b.product_id = p.id AND b.variant_key = IFNULL(v.id, 0)
           AND b.warehouse_id IN (:warehouseIds)
      LEFT JOIN units u ON u.id = p.base_unit_id
      LEFT JOIN product_categories c ON c.id = p.category_id
      LEFT JOIN brands br ON br.id = p.brand_id
     WHERE ${where.join(' AND ')}
     GROUP BY p.id, v.id
     ${having}`;
  const image = `, (SELECT pi.path FROM product_images pi WHERE pi.product_id = p.id
                     ORDER BY pi.is_primary DESC, pi.sort_order LIMIT 1) AS imageUrl`;

  const [rows, [{ total }]] = await Promise.all([
    select(`${query(image)} ORDER BY ${order}, p.id, v.id LIMIT :limit OFFSET :offset`, {
      ...replacements,
      limit,
      offset: (page - 1) * limit,
    }),
    select(`SELECT COUNT(*) AS total FROM (${query()}) x`, replacements),
  ]);
  return { rows: rows.map(shapeStockRow), total: Number(total) };
}

// ── Lookups ────────────────────────────────────────────────────────────────

/** Active warehouses of the request's branches (for warehouse pickers). */
export async function listWarehouses(ctx) {
  const rows = await Warehouse.findAll({
    where: {
      companyId: ctx.auth.companyId,
      branchId: { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] },
    },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
    attributes: ['id', 'name', 'code', 'branchId', 'isDefault', 'isActive'],
    order: [
      ['isActive', 'DESC'],
      ['name', 'ASC'],
    ],
  });
  return rows.map((r) => r.toJSON());
}

/** Every active warehouse of the company — transfer destinations may be in other branches. */
export async function listTransferDestinations(ctx) {
  const rows = await Warehouse.findAll({
    where: { companyId: ctx.auth.companyId, isActive: true },
    include: [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
    attributes: ['id', 'name', 'code', 'branchId'],
    order: [['name', 'ASC']],
  });
  return rows.map((r) => r.toJSON());
}

// ── Stock overview ─────────────────────────────────────────────────────────

export async function stockOverview(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const p = paging(query, 100);
  const { rows, total } = await stockRows(
    ctx,
    warehouseIds,
    {
      categoryId: query.categoryId,
      brandId: query.brandId,
      status: query.status,
      search: typeof query.search === 'string' ? query.search.trim() : '',
      includeInactive: query.includeInactive === 'true',
    },
    { ...p, sort: query.sort || 'name' },
  );
  return { rows, count: total, page: p.page, limit: p.limit };
}

/** Totals per warehouse: items in stock, value, low/out counts and incoming transfers. */
export async function stockSummary(ctx, query = {}) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const rows = await select(
    `SELECT w.id, w.name, w.code, w.is_active AS isActive, br.id AS branchId, br.name AS branchName,
            COUNT(CASE WHEN b.quantity > 0 THEN 1 END) AS itemsInStock,
            COALESCE(SUM(b.total_value), 0) AS totalValue,
            COUNT(CASE WHEN b.quantity > 0 AND p.reorder_level > 0 AND b.quantity <= p.reorder_level THEN 1 END) AS lowCount,
            COUNT(CASE WHEN b.quantity <= 0 THEN 1 END) AS outCount,
            COUNT(CASE WHEN b.quantity < 0 THEN 1 END) AS negativeCount,
            (SELECT COALESCE(SUM(t.total_value), 0) FROM stock_transfers t
              WHERE t.to_warehouse_id = w.id AND t.status = 'in_transit' AND t.deleted_at IS NULL) AS incomingValue
       FROM warehouses w
       JOIN branches br ON br.id = w.branch_id
       LEFT JOIN stock_balances b ON b.warehouse_id = w.id
       LEFT JOIN products p ON p.id = b.product_id
      WHERE w.id IN (:warehouseIds) AND w.deleted_at IS NULL
      GROUP BY w.id, w.name, w.code, w.is_active, br.id, br.name
      ORDER BY w.name`,
    { warehouseIds },
  );
  const warehouses = rows.map((r) => ({
    ...r,
    id: String(r.id),
    branchId: String(r.branchId),
    isActive: Boolean(r.isActive),
    itemsInStock: Number(r.itemsInStock),
    lowCount: Number(r.lowCount),
    outCount: Number(r.outCount),
    negativeCount: Number(r.negativeCount),
    totalValue: fixed4(r.totalValue),
    incomingValue: fixed4(r.incomingValue),
  }));
  const sum = (key) => warehouses.reduce((s, w) => s.plus(w[key]), D(0));
  return {
    warehouses,
    totals: {
      totalValue: fixed4(sum('totalValue')),
      incomingValue: fixed4(sum('incomingValue')),
      lowCount: sum('lowCount').toNumber(),
      outCount: sum('outCount').toNumber(),
    },
  };
}

// ── One product ────────────────────────────────────────────────────────────

async function findProduct(ctx, productId) {
  const product = await Product.findOne({
    where: { id: productId, companyId: ctx.auth.companyId },
    attributes: [
      'id',
      'name',
      'sku',
      'barcode',
      'type',
      'hasVariants',
      'trackBatch',
      'trackSerial',
      'trackExpiry',
      'reorderLevel',
      'purchasePrice',
      'salePrice',
      'isActive',
    ],
    include: [
      { model: Unit, as: 'baseUnit', attributes: ['id', 'code', 'name'] },
      { model: ProductVariant, as: 'variants', attributes: ['id', 'name', 'sku', 'barcode', 'isActive'] },
      {
        model: ProductUnit,
        as: 'units',
        attributes: ['unitId', 'factor'],
        include: [{ model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] }],
      },
    ],
    paranoid: false,
  });
  if (!product) throw AppError.notFound('Product not found');
  return product;
}

/** Stock of one product: per warehouse (and variant), batches and serial counts. */
export async function productStock(ctx, productId, query = {}) {
  const product = await findProduct(ctx, productId);
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const replacements = { productId: product.id, warehouseIds };
  const [balances, batches, serials] = await Promise.all([
    select(
      `SELECT b.warehouse_id AS warehouseId, w.name AS warehouseName, w.code AS warehouseCode,
              b.variant_id AS variantId, v.name AS variantName, b.quantity, b.avg_cost AS avgCost,
              b.total_value AS totalValue, b.last_movement_at AS lastMovementAt
         FROM stock_balances b
         JOIN warehouses w ON w.id = b.warehouse_id
         LEFT JOIN product_variants v ON v.id = b.variant_id
        WHERE b.product_id = :productId AND b.warehouse_id IN (:warehouseIds)
        ORDER BY w.name, v.name`,
      replacements,
    ),
    select(
      `SELECT bt.id AS batchId, bt.batch_no AS batchNo, bt.expiry_date AS expiryDate, bt.mfg_date AS mfgDate,
              l.warehouse_id AS warehouseId, w.name AS warehouseName, bt.variant_id AS variantId,
              SUM(l.remaining) AS quantity, SUM(l.remaining * l.unit_cost) AS totalValue
         FROM stock_layers l
         JOIN stock_batches bt ON bt.id = l.batch_id
         JOIN warehouses w ON w.id = l.warehouse_id
        WHERE l.product_id = :productId AND l.warehouse_id IN (:warehouseIds) AND l.remaining > 0
        GROUP BY bt.id, bt.batch_no, bt.expiry_date, bt.mfg_date, l.warehouse_id, w.name, bt.variant_id
        ORDER BY bt.expiry_date IS NULL, bt.expiry_date, bt.batch_no`,
      replacements,
    ),
    select(
      `SELECT s.warehouse_id AS warehouseId, s.status, COUNT(*) AS count
         FROM stock_serials s
        WHERE s.product_id = :productId AND (s.warehouse_id IN (:warehouseIds) OR s.warehouse_id IS NULL)
        GROUP BY s.warehouse_id, s.status`,
      replacements,
    ),
  ]);
  const totalQty = balances.reduce((s, b) => s.plus(b.quantity), D(0));
  const totalValue = balances.reduce((s, b) => s.plus(b.totalValue), D(0));
  return {
    product: product.toJSON(),
    totals: {
      quantity: fixed4(totalQty),
      totalValue: fixed4(totalValue),
      avgCost: totalQty.gt(0) ? fixed4(totalValue.dividedBy(totalQty)) : fixed4(product.purchasePrice),
      status: stockStatus(totalQty, product.reorderLevel),
    },
    balances: balances.map((b) => ({
      ...b,
      warehouseId: String(b.warehouseId),
      variantId: b.variantId ? String(b.variantId) : null,
      quantity: fixed4(b.quantity),
      avgCost: fixed4(b.avgCost),
      totalValue: fixed4(b.totalValue),
    })),
    batches: batches.map((b) => ({
      ...b,
      batchId: String(b.batchId),
      warehouseId: String(b.warehouseId),
      variantId: b.variantId ? String(b.variantId) : null,
      quantity: fixed4(b.quantity),
      totalValue: fixed4(b.totalValue),
    })),
    serials: serials.map((s) => ({
      ...s,
      warehouseId: s.warehouseId ? String(s.warehouseId) : null,
      count: Number(s.count),
    })),
  };
}

/**
 * Stock card: the product's movements (newest first) with a running balance in date order,
 * plus opening and closing balances for the chosen period.
 */
export async function stockCard(ctx, productId, query) {
  const product = await findProduct(ctx, productId);
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const p = paging(query, 200);
  const replacements = {
    companyId: ctx.auth.companyId,
    productId: product.id,
    warehouseIds,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  const variantFilter = query.variantId ? 'AND m.variant_id = :variantId' : '';
  if (query.variantId) replacements.variantId = query.variantId;
  const base = `FROM stock_movements m
     WHERE m.company_id = :companyId AND m.product_id = :productId AND m.warehouse_id IN (:warehouseIds) ${variantFilter}`;
  const range = `(:from IS NULL OR x.movementDate >= :from) AND (:to IS NULL OR x.movementDate <= :to)`;

  const [rows, [totals]] = await Promise.all([
    select(
      `SELECT x.*, w.name AS warehouseName, v.name AS variantName, bt.batch_no AS batchNo,
              bt.expiry_date AS expiryDate, u.name AS userName
         FROM (SELECT m.id, m.movement_date AS movementDate, m.created_at AS createdAt, m.movement_type AS movementType,
                      m.reference_type AS referenceType, m.reference_id AS referenceId, m.reference_no AS referenceNo,
                      m.warehouse_id AS warehouseId, m.variant_id AS variantId, m.batch_id AS batchId,
                      m.quantity, m.unit_cost AS unitCost, m.total_cost AS totalCost, m.notes, m.created_by AS createdBy,
                      SUM(m.quantity) OVER (ORDER BY m.movement_date, m.id) AS runningQuantity,
                      SUM(m.total_cost) OVER (ORDER BY m.movement_date, m.id) AS runningValue
                 ${base}) x
         JOIN warehouses w ON w.id = x.warehouseId
         LEFT JOIN product_variants v ON v.id = x.variantId
         LEFT JOIN stock_batches bt ON bt.id = x.batchId
         LEFT JOIN users u ON u.id = x.createdBy
        WHERE ${range}
        ORDER BY x.movementDate DESC, x.id DESC
        LIMIT :limit OFFSET :offset`,
      { ...replacements, limit: p.limit, offset: p.offset },
    ),
    select(
      `SELECT COUNT(CASE WHEN ${range} THEN 1 END) AS total,
              COALESCE(SUM(CASE WHEN :from IS NOT NULL AND x.movementDate < :from THEN x.quantity END), 0) AS openingQuantity,
              COALESCE(SUM(CASE WHEN :from IS NOT NULL AND x.movementDate < :from THEN x.totalCost END), 0) AS openingValue,
              COALESCE(SUM(CASE WHEN ${range} AND x.quantity > 0 THEN x.quantity END), 0) AS inQuantity,
              COALESCE(SUM(CASE WHEN ${range} AND x.quantity < 0 THEN -x.quantity END), 0) AS outQuantity,
              COALESCE(SUM(CASE WHEN :to IS NULL OR x.movementDate <= :to THEN x.quantity END), 0) AS closingQuantity,
              COALESCE(SUM(CASE WHEN :to IS NULL OR x.movementDate <= :to THEN x.totalCost END), 0) AS closingValue
         FROM (SELECT m.movement_date AS movementDate, m.quantity, m.total_cost AS totalCost ${base}) x`,
      replacements,
    ),
  ]);

  return {
    data: {
      product: product.toJSON(),
      opening: { quantity: fixed4(totals.openingQuantity), value: fixed4(totals.openingValue) },
      closing: { quantity: fixed4(totals.closingQuantity), value: fixed4(totals.closingValue) },
      inQuantity: fixed4(totals.inQuantity),
      outQuantity: fixed4(totals.outQuantity),
      rows: rows.map((r) => ({
        ...r,
        id: String(r.id),
        referenceId: String(r.referenceId),
        warehouseId: String(r.warehouseId),
        variantId: r.variantId ? String(r.variantId) : null,
        batchId: r.batchId ? String(r.batchId) : null,
        quantity: fixed4(r.quantity),
        unitCost: fixed4(r.unitCost),
        totalCost: fixed4(r.totalCost),
        runningQuantity: fixed4(r.runningQuantity),
        runningValue: fixed4(r.runningValue),
      })),
    },
    meta: meta(p, Number(totals.total)),
  };
}

// ── Ledger ─────────────────────────────────────────────────────────────────

export async function listMovements(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const q = parseListQuery(query, {
    sortable: ['id', 'movementDate', 'quantity', 'totalCost'],
    filterable: ['productId', 'variantId', 'movementType', 'referenceType'],
    defaultSort: '-id',
  });
  const where = { ...q.where, companyId: ctx.auth.companyId, warehouseId: { [Op.in]: warehouseIds } };
  delete where[Op.or];
  if (query.from || query.to) {
    where.movementDate = {
      ...(query.from && { [Op.gte]: query.from }),
      ...(query.to && { [Op.lte]: query.to }),
    };
  }
  if (q.search) {
    const like = { [Op.like]: `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
    where[Op.or] = [{ referenceNo: like }, { '$product.name$': like }, { '$product.sku$': like }];
  }
  const { rows, count } = await StockMovement.findAndCountAll({
    where,
    include: [
      { model: Product, as: 'product', attributes: ['id', 'name', 'sku'], paranoid: false },
      { model: ProductVariant, as: 'variant', attributes: ['id', 'name', 'sku'], paranoid: false },
      { model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'], paranoid: false },
      { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'expiryDate'] },
      { model: User, as: 'creator', attributes: ['id', 'name'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    subQuery: false,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

// ── Batches & serials ──────────────────────────────────────────────────────

export async function listBatches(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const rows = await select(
    `SELECT bt.id, bt.batch_no AS batchNo, bt.expiry_date AS expiryDate, bt.mfg_date AS mfgDate,
            COALESCE(SUM(l.remaining), 0) AS quantity
       FROM stock_batches bt
       LEFT JOIN stock_layers l ON l.batch_id = bt.id AND l.warehouse_id IN (:warehouseIds) AND l.remaining > 0
      WHERE bt.company_id = :companyId AND bt.product_id = :productId AND bt.variant_key = :variantKey
      GROUP BY bt.id, bt.batch_no, bt.expiry_date, bt.mfg_date
      ${query.available === 'true' ? 'HAVING quantity > 0' : ''}
      ORDER BY bt.expiry_date IS NULL, bt.expiry_date, bt.id`,
    {
      companyId: ctx.auth.companyId,
      productId: query.productId,
      variantKey: query.variantId ?? 0,
      warehouseIds,
    },
  );
  return rows.map((r) => ({ ...r, id: String(r.id), quantity: fixed4(r.quantity) }));
}

export async function listSerials(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const q = parseListQuery(query, {
    sortable: ['serialNo', 'updatedAt'],
    searchable: ['serialNo'],
    filterable: ['productId', 'variantId', 'batchId', 'status'],
    defaultSort: 'serialNo',
  });
  const { rows, count } = await StockSerial.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, warehouseId: { [Op.in]: warehouseIds } },
    include: [
      { model: Product, as: 'product', attributes: ['id', 'name', 'sku'], paranoid: false },
      { model: ProductVariant, as: 'variant', attributes: ['id', 'name'], paranoid: false },
      { model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'], paranoid: false },
      { model: StockBatch, as: 'batch', attributes: ['id', 'batchNo', 'expiryDate'] },
    ],
    order: q.order,
    limit: q.limit,
    offset: q.offset,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

// ── Item search (document forms) ───────────────────────────────────────────

/**
 * Find stockable items by name, SKU or barcode — including variant SKUs/barcodes and pack
 * barcodes (a pack match preselects that unit). `exact` is for scanners: exact codes only.
 * Variant products expand into their variants. Availability is for `warehouseId`.
 */
export async function searchItems(ctx, { q, warehouseId, exact, limit }) {
  const companyId = ctx.auth.companyId;
  const term = q.trim();
  if (!term) return [];
  const like = { [Op.like]: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
  const stockable = { companyId, isActive: true, type: { [Op.ne]: 'service' } };

  const [products, variants, packs] = await Promise.all([
    Product.findAll({
      where: {
        ...stockable,
        [Op.or]:
          exact === 'true'
            ? [{ barcode: term }, { sku: term }]
            : [{ name: like }, { sku: like }, { barcode: term }],
      },
      attributes: ['id'],
      limit,
      order: [['name', 'ASC']],
      raw: true,
    }),
    ProductVariant.findAll({
      where: {
        companyId,
        isActive: true,
        [Op.or]: exact === 'true' ? [{ barcode: term }, { sku: term }] : [{ sku: like }, { barcode: term }],
      },
      attributes: ['id', 'productId'],
      limit,
      raw: true,
    }),
    ProductUnit.findAll({
      where: { barcode: term },
      include: [{ model: Product, as: 'product', attributes: [], where: stockable, required: true }],
      attributes: ['productId', 'unitId'],
      raw: true,
    }),
  ]);

  const productIds = [
    ...new Set(
      [
        ...products,
        ...variants.map((v) => ({ id: v.productId })),
        ...packs.map((p) => ({ id: p.productId })),
      ].map((r) => String(r.id)),
    ),
  ];
  if (!productIds.length) return [];
  const full = await Product.findAll({
    where: { id: productIds, ...stockable },
    attributes: [
      'id',
      'name',
      'sku',
      'barcode',
      'hasVariants',
      'trackBatch',
      'trackSerial',
      'trackExpiry',
      'purchasePrice',
      'baseUnitId',
      'taxGroupId',
    ],
    include: [
      { model: Unit, as: 'baseUnit', attributes: ['id', 'code', 'name', 'allowDecimal'] },
      { model: ProductVariant, as: 'variants', attributes: ['id', 'name', 'sku', 'barcode', 'isActive'] },
      {
        model: ProductUnit,
        as: 'units',
        attributes: ['unitId', 'factor'],
        include: [{ model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] }],
      },
    ],
    order: [['name', 'ASC']],
  });

  const matchedVariants = new Set(variants.map((v) => String(v.id)));
  const packUnit = new Map(packs.map((p) => [String(p.productId), String(p.unitId)]));
  const items = [];
  for (const p of full) {
    const base = {
      productId: String(p.id),
      name: p.name,
      baseUnit: p.baseUnit,
      units: [
        { unitId: String(p.baseUnitId), code: p.baseUnit?.code, name: p.baseUnit?.name, factor: '1' },
        ...p.units.map((u) => ({
          unitId: String(u.unitId),
          code: u.unit?.code,
          name: u.unit?.name,
          factor: u.factor,
        })),
      ],
      matchedUnitId: packUnit.get(String(p.id)) ?? null,
      trackBatch: p.trackBatch,
      trackSerial: p.trackSerial,
      trackExpiry: p.trackExpiry,
      lotTracked: isLotTracked(p),
      purchasePrice: p.purchasePrice,
      taxGroupId: p.taxGroupId ? String(p.taxGroupId) : null,
    };
    if (!p.hasVariants) {
      items.push({
        ...base,
        key: `${p.id}:`,
        variantId: null,
        variantName: null,
        sku: p.sku,
        barcode: p.barcode,
      });
      continue;
    }
    // A variant hit narrows to that variant; a product hit lists all active variants.
    const hits = p.variants.filter((v) => v.isActive && matchedVariants.has(String(v.id)));
    for (const v of (hits.length ? hits : p.variants.filter((x) => x.isActive)).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      items.push({
        ...base,
        key: `${p.id}:${v.id}`,
        variantId: String(v.id),
        variantName: v.name,
        sku: v.sku,
        barcode: v.barcode,
      });
    }
  }
  const limited = items.slice(0, limit);

  if (warehouseId) {
    const [warehouseIdOk] = await scopeWarehouses(ctx, warehouseId);
    const balances = await select(
      `SELECT product_id AS productId, variant_id AS variantId, quantity, avg_cost AS avgCost
         FROM stock_balances WHERE warehouse_id = :warehouseId AND product_id IN (:productIds)`,
      { warehouseId: warehouseIdOk, productIds: [...new Set(limited.map((i) => i.productId))] },
    );
    const balanceOf = new Map(balances.map((b) => [`${b.productId}:${b.variantId ?? ''}`, b]));
    for (const item of limited) {
      const b = balanceOf.get(item.key);
      item.available = fixed4(b?.quantity ?? 0);
      item.avgCost = fixed4(D(b?.avgCost).gt(0) ? b.avgCost : item.purchasePrice);
    }
  }
  return limited;
}

// ── Alerts ─────────────────────────────────────────────────────────────────

async function expiringBatches(ctx, warehouseIds, { today, until, expired, limit }) {
  const rows = await select(
    `SELECT bt.id AS batchId, bt.batch_no AS batchNo, bt.expiry_date AS expiryDate,
            p.id AS productId, p.name, v.id AS variantId, v.name AS variantName, p.sku, u.code AS unitCode,
            l.warehouse_id AS warehouseId, w.name AS warehouseName,
            SUM(l.remaining) AS quantity, SUM(l.remaining * l.unit_cost) AS totalValue,
            DATEDIFF(bt.expiry_date, :today) AS daysLeft
       FROM stock_layers l
       JOIN stock_batches bt ON bt.id = l.batch_id
       JOIN products p ON p.id = l.product_id
       LEFT JOIN product_variants v ON v.id = l.variant_id
       LEFT JOIN units u ON u.id = p.base_unit_id
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.warehouse_id IN (:warehouseIds) AND l.remaining > 0 AND bt.expiry_date IS NOT NULL
        AND ${expired ? 'bt.expiry_date < :today' : 'bt.expiry_date >= :today AND bt.expiry_date <= :until'}
      GROUP BY bt.id, bt.batch_no, bt.expiry_date, p.id, p.name, v.id, v.name, p.sku, u.code, l.warehouse_id, w.name
      ORDER BY bt.expiry_date, p.name
      ${limit ? 'LIMIT :limit' : ''}`,
    { warehouseIds, today, until, limit },
  );
  return rows.map((r) => ({
    ...r,
    batchId: String(r.batchId),
    productId: String(r.productId),
    variantId: r.variantId ? String(r.variantId) : null,
    warehouseId: String(r.warehouseId),
    quantity: fixed4(r.quantity),
    totalValue: fixed4(r.totalValue),
    daysLeft: Number(r.daysLeft),
  }));
}

const plusDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Low stock, out of stock, near-expiry and expired batches, plus work waiting for the user. */
export async function stockAlerts(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const settings = await inventorySettings(ctx.auth.companyId);
  const today = await companyToday(ctx.auth.companyId);
  const until = plusDays(today, settings.nearExpiryDays);
  const limit = query.limit ?? 10;
  const scope = { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] };

  const [
    low,
    out,
    nearExpiry,
    expired,
    nearExpiryAll,
    expiredAll,
    pendingAdjustments,
    pendingCounts,
    incomingTransfers,
  ] = await Promise.all([
    stockRows(ctx, warehouseIds, { status: 'low' }, { limit, sort: 'quantity' }),
    stockRows(ctx, warehouseIds, { status: 'out_alert' }, { limit, sort: 'name' }),
    expiringBatches(ctx, warehouseIds, { today, until, limit }),
    expiringBatches(ctx, warehouseIds, { today, expired: true, limit }),
    select(
      `SELECT COUNT(DISTINCT l.batch_id, l.warehouse_id) AS n FROM stock_layers l JOIN stock_batches bt ON bt.id = l.batch_id
          WHERE l.warehouse_id IN (:warehouseIds) AND l.remaining > 0 AND bt.expiry_date >= :today AND bt.expiry_date <= :until`,
      { warehouseIds, today, until },
    ),
    select(
      `SELECT COUNT(DISTINCT l.batch_id, l.warehouse_id) AS n FROM stock_layers l JOIN stock_batches bt ON bt.id = l.batch_id
          WHERE l.warehouse_id IN (:warehouseIds) AND l.remaining > 0 AND bt.expiry_date < :today`,
      { warehouseIds, today },
    ),
    StockAdjustment.count({
      where: { companyId: ctx.auth.companyId, branchId: scope, status: 'pending_approval' },
    }),
    StockCount.count({
      where: { companyId: ctx.auth.companyId, branchId: scope, status: 'pending_approval' },
    }),
    StockTransfer.count({
      where: { companyId: ctx.auth.companyId, toBranchId: scope, status: 'in_transit' },
    }),
  ]);

  return {
    settings: { nearExpiryDays: settings.nearExpiryDays },
    counts: {
      lowStock: low.total,
      outOfStock: out.total,
      nearExpiry: Number(nearExpiryAll[0].n),
      expired: Number(expiredAll[0].n),
      pendingApprovals: pendingAdjustments + pendingCounts,
      incomingTransfers,
    },
    lowStock: low.rows,
    outOfStock: out.rows,
    nearExpiry,
    expired,
  };
}

// ── Reports ────────────────────────────────────────────────────────────────

/** Stock valuation by item, category or warehouse at current cost. */
export async function valuationReport(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const groupBy = query.groupBy ?? 'item';
  const settings = await inventorySettings(ctx.auth.companyId);
  const p = paging(query);

  if (groupBy === 'warehouse') {
    const { warehouses, totals } = await stockSummary(ctx, query);
    return {
      data: { rows: warehouses, summary: { ...totals, costingMethod: settings.costingMethod } },
      meta: meta({ page: 1, limit: warehouses.length || 1 }, warehouses.length),
    };
  }
  if (groupBy === 'category') {
    const rows = await select(
      `SELECT c.id AS categoryId, COALESCE(c.name, '—') AS category,
              COUNT(DISTINCT CASE WHEN b.quantity > 0 THEN b.id END) AS itemsInStock,
              COALESCE(SUM(b.quantity), 0) AS quantity, COALESCE(SUM(b.total_value), 0) AS totalValue
         FROM stock_balances b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN product_categories c ON c.id = p.category_id
        WHERE b.warehouse_id IN (:warehouseIds) AND b.quantity <> 0
        GROUP BY c.id, c.name
        ORDER BY totalValue DESC`,
      { warehouseIds },
    );
    const total = rows.reduce((s, r) => s.plus(r.totalValue), D(0));
    return {
      data: {
        rows: rows.map((r) => ({
          ...r,
          categoryId: r.categoryId ? String(r.categoryId) : null,
          itemsInStock: Number(r.itemsInStock),
          quantity: fixed4(r.quantity),
          totalValue: fixed4(r.totalValue),
          share: total.gt(0) ? D(r.totalValue).dividedBy(total).times(100).toFixed(2) : '0.00',
        })),
        summary: { totalValue: fixed4(total), costingMethod: settings.costingMethod },
      },
      meta: meta({ page: 1, limit: rows.length || 1 }, rows.length),
    };
  }
  const filters = {
    categoryId: query.categoryId,
    status: 'nonzero',
    search: typeof query.search === 'string' ? query.search.trim() : '',
  };
  const [{ rows, total }, [sum]] = await Promise.all([
    stockRows(ctx, warehouseIds, filters, { ...p, sort: query.sort || '-value' }),
    select(
      `SELECT COALESCE(SUM(b.total_value), 0) AS totalValue, COALESCE(SUM(b.quantity), 0) AS quantity
         FROM stock_balances b WHERE b.warehouse_id IN (:warehouseIds)`,
      { warehouseIds },
    ),
  ]);
  return {
    data: { rows, summary: { totalValue: fixed4(sum.totalValue), costingMethod: settings.costingMethod } },
    meta: meta(p, total),
  };
}

/** Items in stock with no consumption for a while (slow-moving) or a long while (dead). */
export async function slowMovingReport(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const settings = await inventorySettings(ctx.auth.companyId);
  const slowDays = query.days ?? settings.slowMovingDays;
  const deadDays = Math.max(settings.deadStockDays, slowDays);
  const threshold = query.class === 'dead' ? deadDays : slowDays;
  const p = paging(query);
  const inner = `
    SELECT b.product_id AS productId, b.variant_id AS variantId, MAX(p.name) AS name, MAX(v.name) AS variantName,
           MAX(COALESCE(v.sku, p.sku)) AS sku, MAX(u.code) AS unitCode,
           SUM(b.quantity) AS quantity, SUM(b.total_value) AS totalValue,
           MAX(b.last_issue_at) AS lastIssueAt, MIN(b.created_at) AS firstStockedAt,
           DATEDIFF(NOW(), COALESCE(MAX(b.last_issue_at), MIN(b.created_at))) AS idleDays
      FROM stock_balances b
      JOIN products p ON p.id = b.product_id AND p.deleted_at IS NULL
      LEFT JOIN product_variants v ON v.id = b.variant_id
      LEFT JOIN units u ON u.id = p.base_unit_id
     WHERE b.warehouse_id IN (:warehouseIds) AND b.quantity > 0
     GROUP BY b.product_id, b.variant_id
    HAVING idleDays >= :threshold`;
  const replacements = { warehouseIds, threshold };
  const [rows, [agg]] = await Promise.all([
    select(`${inner} ORDER BY idleDays DESC, totalValue DESC LIMIT :limit OFFSET :offset`, {
      ...replacements,
      limit: p.limit,
      offset: p.offset,
    }),
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(totalValue), 0) AS totalValue,
              COUNT(CASE WHEN idleDays >= :deadDays THEN 1 END) AS deadCount,
              COALESCE(SUM(CASE WHEN idleDays >= :deadDays THEN totalValue END), 0) AS deadValue
         FROM (${inner}) x`,
      { ...replacements, deadDays },
    ),
  ]);
  return {
    data: {
      rows: rows.map((r) => ({
        ...r,
        key: `${r.productId}:${r.variantId ?? ''}`,
        productId: String(r.productId),
        variantId: r.variantId ? String(r.variantId) : null,
        quantity: fixed4(r.quantity),
        totalValue: fixed4(r.totalValue),
        idleDays: Number(r.idleDays),
        class: Number(r.idleDays) >= deadDays ? 'dead' : 'slow',
      })),
      summary: {
        slowDays,
        deadDays,
        count: Number(agg.total),
        totalValue: fixed4(agg.totalValue),
        deadCount: Number(agg.deadCount),
        deadValue: fixed4(agg.deadValue),
      },
    },
    meta: meta(p, Number(agg.total)),
  };
}

/**
 * ABC analysis: items ranked by consumption value in a period (or by current stock value).
 * A = items making up the first 80% of value, B = the next 15%, C = the rest.
 */
export async function abcReport(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const basis = query.basis ?? 'consumption';
  const today = await companyToday(ctx.auth.companyId);
  const to = query.to ?? today;
  const from = query.from ?? plusDays(to, -365);
  const rows =
    basis === 'stock_value'
      ? await select(
          `SELECT b.product_id AS productId, b.variant_id AS variantId, MAX(p.name) AS name, MAX(v.name) AS variantName,
                  MAX(COALESCE(v.sku, p.sku)) AS sku, MAX(u.code) AS unitCode,
                  SUM(b.quantity) AS quantity, SUM(b.total_value) AS value
             FROM stock_balances b
             JOIN products p ON p.id = b.product_id
             LEFT JOIN product_variants v ON v.id = b.variant_id
             LEFT JOIN units u ON u.id = p.base_unit_id
            WHERE b.warehouse_id IN (:warehouseIds) AND b.quantity > 0
            GROUP BY b.product_id, b.variant_id
           HAVING value > 0
            ORDER BY value DESC`,
          { warehouseIds },
        )
      : await select(
          `SELECT m.product_id AS productId, m.variant_id AS variantId, MAX(p.name) AS name, MAX(v.name) AS variantName,
                  MAX(COALESCE(v.sku, p.sku)) AS sku, MAX(u.code) AS unitCode,
                  SUM(-m.quantity) AS quantity, SUM(-m.total_cost) AS value
             FROM stock_movements m
             JOIN products p ON p.id = m.product_id
             LEFT JOIN product_variants v ON v.id = m.variant_id
             LEFT JOIN units u ON u.id = p.base_unit_id
            WHERE m.warehouse_id IN (:warehouseIds) AND m.quantity < 0
              AND m.movement_type NOT IN ('transfer_out', 'count_loss', 'damage', 'scrap', 'purchase_return')
              AND m.movement_date BETWEEN :from AND :to
            GROUP BY m.product_id, m.variant_id
           HAVING value > 0
            ORDER BY value DESC`,
          { warehouseIds, from, to },
        );

  const total = rows.reduce((s, r) => s.plus(r.value), D(0));
  let running = D(0);
  const classes = {
    A: { count: 0, value: D(0) },
    B: { count: 0, value: D(0) },
    C: { count: 0, value: D(0) },
  };
  const ranked = rows.map((r, i) => {
    const before = total.gt(0) ? running.dividedBy(total).times(100) : D(0);
    running = running.plus(r.value);
    // The item that crosses a threshold still belongs to the class it started in.
    const cls = before.lt(80) ? 'A' : before.lt(95) ? 'B' : 'C';
    classes[cls].count += 1;
    classes[cls].value = classes[cls].value.plus(r.value);
    return {
      rank: i + 1,
      key: `${r.productId}:${r.variantId ?? ''}`,
      productId: String(r.productId),
      variantId: r.variantId ? String(r.variantId) : null,
      name: r.name,
      variantName: r.variantName,
      sku: r.sku,
      unitCode: r.unitCode,
      quantity: fixed4(r.quantity),
      value: fixed4(r.value),
      share: total.gt(0) ? D(r.value).dividedBy(total).times(100).toFixed(2) : '0.00',
      cumulativeShare: total.gt(0) ? running.dividedBy(total).times(100).toFixed(2) : '0.00',
      class: cls,
    };
  });
  const p = paging(query);
  const filtered =
    query.class && ['A', 'B', 'C'].includes(query.class)
      ? ranked.filter((r) => r.class === query.class)
      : ranked;
  return {
    data: {
      rows: filtered.slice(p.offset, p.offset + p.limit),
      summary: {
        basis,
        from: basis === 'consumption' ? from : null,
        to: basis === 'consumption' ? to : null,
        totalValue: fixed4(total),
        classes: Object.fromEntries(
          Object.entries(classes).map(([k, v]) => [
            k,
            {
              count: v.count,
              value: fixed4(v.value),
              share: total.gt(0) ? v.value.dividedBy(total).times(100).toFixed(2) : '0.00',
            },
          ]),
        ),
      },
    },
    meta: meta(p, filtered.length),
  };
}

/** Batches in stock by expiry date: expired, expiring within `days`, or all. */
export async function expiryReport(ctx, query) {
  const warehouseIds = await scopeWarehouses(ctx, query.warehouseId);
  const settings = await inventorySettings(ctx.auth.companyId);
  const today = await companyToday(ctx.auth.companyId);
  const days = query.days ?? settings.nearExpiryDays;
  const until = plusDays(today, days);
  const status = query.status ?? 'all';
  const p = paging(query);
  const condition = {
    expired: 'bt.expiry_date < :today',
    near: 'bt.expiry_date >= :today AND bt.expiry_date <= :until',
    ok: 'bt.expiry_date > :until',
    all: '1 = 1',
  }[status];
  const inner = `
    SELECT bt.id AS batchId, bt.batch_no AS batchNo, bt.expiry_date AS expiryDate, bt.mfg_date AS mfgDate,
           p.id AS productId, p.name, v.id AS variantId, v.name AS variantName, COALESCE(v.sku, p.sku) AS sku,
           u.code AS unitCode, l.warehouse_id AS warehouseId, w.name AS warehouseName,
           SUM(l.remaining) AS quantity, SUM(l.remaining * l.unit_cost) AS totalValue,
           DATEDIFF(bt.expiry_date, :today) AS daysLeft
      FROM stock_layers l
      JOIN stock_batches bt ON bt.id = l.batch_id
      JOIN products p ON p.id = l.product_id
      LEFT JOIN product_variants v ON v.id = l.variant_id
      LEFT JOIN units u ON u.id = p.base_unit_id
      JOIN warehouses w ON w.id = l.warehouse_id
     WHERE l.warehouse_id IN (:warehouseIds) AND l.remaining > 0 AND bt.expiry_date IS NOT NULL AND ${condition}
     GROUP BY bt.id, bt.batch_no, bt.expiry_date, bt.mfg_date, p.id, p.name, v.id, v.name, v.sku, p.sku, u.code, l.warehouse_id, w.name`;
  const replacements = { warehouseIds, today, until };
  const [rows, [agg]] = await Promise.all([
    select(`${inner} ORDER BY expiryDate, name LIMIT :limit OFFSET :offset`, {
      ...replacements,
      limit: p.limit,
      offset: p.offset,
    }),
    select(
      `SELECT COUNT(*) AS total, COALESCE(SUM(totalValue), 0) AS totalValue,
              COALESCE(SUM(CASE WHEN daysLeft < 0 THEN totalValue END), 0) AS expiredValue,
              COALESCE(SUM(CASE WHEN daysLeft >= 0 AND daysLeft <= :days THEN totalValue END), 0) AS nearValue
         FROM (${inner}) x`,
      { ...replacements, days },
    ),
  ]);
  return {
    data: {
      rows: rows.map((r) => {
        const daysLeft = Number(r.daysLeft);
        return {
          ...r,
          key: `${r.batchId}:${r.warehouseId}`,
          batchId: String(r.batchId),
          productId: String(r.productId),
          variantId: r.variantId ? String(r.variantId) : null,
          warehouseId: String(r.warehouseId),
          quantity: fixed4(r.quantity),
          totalValue: fixed4(r.totalValue),
          daysLeft,
          status: daysLeft < 0 ? 'expired' : daysLeft <= days ? 'near' : 'ok',
        };
      }),
      summary: {
        days,
        today,
        count: Number(agg.total),
        totalValue: fixed4(agg.totalValue),
        expiredValue: fixed4(agg.expiredValue),
        nearValue: fixed4(agg.nearValue),
      },
    },
    meta: meta(p, Number(agg.total)),
  };
}

export { itemName };
