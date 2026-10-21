import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  Company,
  Party,
  PaymentMethod,
  PosRegister,
  Product,
  ProductCategory,
  ProductImage,
  ProductUnit,
  ProductVariant,
  TaxGroup,
  Unit,
} from '../../models.js';
import { isLotTracked } from '../inventory/stock.engine.js';
import { customers as customerService } from '../parties/parties.service.js';
import { getSettings } from '../settings/settings.service.js';
import { loadGroupRates } from '../taxes/taxes.service.js';
import { D, fixed, invalid, openSessionOf, posSettings, registerIncludes } from './pos.common.js';
import { getSession } from './sessions.service.js';

const select = (sql, replacements, t) =>
  sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction: t });

/**
 * Everything the POS screen needs to start (and to keep working offline): the registers the user
 * can use, the chosen register's open session, settings, tax rates (totals are computed on the
 * device exactly like the server does), payment methods and categories.
 */
export async function bootstrap(ctx, { registerId } = {}) {
  const companyId = ctx.auth.companyId;
  const registers = await PosRegister.findAll({
    where: { companyId, isActive: true, branchId: ctx.branchIds.length ? ctx.branchIds : [0] },
    include: registerIncludes(),
    order: [['name', 'ASC']],
  });
  const register = registerId ? registers.find((r) => String(r.id) === String(registerId)) : null;
  if (registerId && !register) throw invalid('registerId', 'Register not found');
  const [session, pos, sales, financial, methods, groups, categories, company] = await Promise.all([
    register ? openSessionOf(register.id) : null,
    posSettings(companyId),
    getSettings(companyId, 'sales'),
    getSettings(companyId, 'financial'),
    PaymentMethod.findAll({
      where: { companyId, isActive: true },
      attributes: ['id', 'name', 'code', 'type', 'requiresReference'],
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    TaxGroup.findAll({ where: { companyId, isActive: true }, attributes: ['id', 'name', 'code'] }),
    ProductCategory.findAll({
      where: { companyId, isActive: true },
      attributes: ['id', 'name', 'parentId', 'sortOrder'],
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    Company.findByPk(companyId, { attributes: ['name', 'address', 'phone', 'email', 'binNo', 'logoUrl'] }),
  ]);
  const taxGroups = [];
  for (const g of groups) {
    const rates = await loadGroupRates(companyId, g.id);
    taxGroups.push({
      id: String(g.id),
      name: g.name,
      rates: rates.map((r) => ({
        name: r.name,
        rate: String(r.rate),
        isCompound: Boolean(r.isCompound),
        sequence: r.sequence,
      })),
    });
  }
  return {
    registers: registers.map((r) => r.toJSON()),
    register: register?.toJSON() ?? null,
    session: session ? await getSession(ctx, session.id) : null,
    settings: {
      pos,
      rounding: { roundTo: sales.roundTo, roundingMode: sales.roundingMode },
      creditCheck: sales.creditCheck,
      amountDecimals: financial.amountDecimals,
      currency: financial.baseCurrency,
    },
    paymentMethods: methods.map((m) => ({ ...m.toJSON(), id: String(m.id) })),
    taxGroups,
    categories: categories.map((c) => ({ ...c.toJSON(), id: String(c.id) })),
    company: company.toJSON(),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Sellable items for a register: one row per product (or variant), with pack units, barcodes,
 * standard price, tax and the stock in the register's warehouse. Cached in IndexedDB on the device.
 */
export async function catalog(ctx, { registerId }) {
  const register = await PosRegister.findOne({
    where: {
      id: registerId,
      companyId: ctx.auth.companyId,
      branchId: ctx.branchIds.length ? ctx.branchIds : [0],
    },
  });
  if (!register) throw invalid('registerId', 'Register not found');
  const companyId = ctx.auth.companyId;
  const [products, stock] = await Promise.all([
    Product.findAll({
      where: { companyId, isActive: true, type: { [Op.ne]: 'service' } },
      attributes: [
        'id',
        'name',
        'sku',
        'barcode',
        'categoryId',
        'baseUnitId',
        'salePrice',
        'taxGroupId',
        'priceIncludesTax',
        'hasVariants',
        'trackBatch',
        'trackSerial',
        'trackExpiry',
        'updatedAt',
      ],
      include: [
        { model: Unit, as: 'baseUnit', attributes: ['id', 'code', 'name', 'allowDecimal'] },
        {
          model: ProductVariant,
          as: 'variants',
          where: { isActive: true },
          required: false,
          attributes: ['id', 'name', 'sku', 'barcode', 'salePrice'],
        },
        {
          model: ProductUnit,
          as: 'units',
          attributes: ['unitId', 'factor', 'barcode', 'salePrice'],
          include: [{ model: Unit, as: 'unit', attributes: ['id', 'code', 'name'] }],
        },
        {
          model: ProductImage,
          as: 'images',
          attributes: ['path', 'isPrimary', 'sortOrder'],
          required: false,
        },
      ],
      order: [['name', 'ASC']],
    }),
    select(
      `SELECT product_id AS productId, variant_id AS variantId, quantity
         FROM stock_balances WHERE warehouse_id = :warehouseId`,
      { warehouseId: register.warehouseId },
    ),
  ]);
  const stockOf = new Map(stock.map((s) => [`${s.productId}:${s.variantId ?? ''}`, fixed(s.quantity)]));
  const items = [];
  for (const p of products) {
    const image =
      [...(p.images ?? [])].sort(
        (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder,
      )[0]?.path ?? null;
    const units = [
      { unitId: String(p.baseUnitId), code: p.baseUnit?.code, factor: '1', barcode: null, salePrice: null },
      ...p.units.map((u) => ({
        unitId: String(u.unitId),
        code: u.unit?.code,
        factor: String(Number(u.factor)),
        barcode: u.barcode,
        salePrice: u.salePrice,
      })),
    ];
    const base = {
      productId: String(p.id),
      name: p.name,
      categoryId: p.categoryId ? String(p.categoryId) : null,
      image,
      baseUnit: p.baseUnit,
      units,
      taxGroupId: p.taxGroupId ? String(p.taxGroupId) : null,
      priceIncludesTax: p.priceIncludesTax,
      lotTracked: isLotTracked(p),
      trackSerial: p.trackSerial,
      updatedAt: p.updatedAt,
    };
    if (!p.hasVariants) {
      items.push({
        ...base,
        key: `${p.id}:`,
        variantId: null,
        variantName: null,
        sku: p.sku,
        barcode: p.barcode,
        price: p.salePrice,
        stock: stockOf.get(`${p.id}:`) ?? '0.0000',
      });
    }
    for (const v of p.variants ?? []) {
      items.push({
        ...base,
        key: `${p.id}:${v.id}`,
        variantId: String(v.id),
        variantName: v.name,
        sku: v.sku,
        barcode: v.barcode,
        price: v.salePrice ?? p.salePrice,
        stock: stockOf.get(`${p.id}:${v.id}`) ?? '0.0000',
      });
    }
  }
  return {
    registerId: String(register.id),
    warehouseId: String(register.warehouseId),
    items,
    generatedAt: new Date(),
  };
}

/** Active customers for the device cache (walk-in first). */
export async function customerList(ctx) {
  const rows = await Party.findAll({
    where: { companyId: ctx.auth.companyId, isCustomer: true, isActive: true },
    attributes: ['id', 'code', 'name', 'phone', 'email', 'customerGroupId', 'creditLimit'],
    order: [['name', 'ASC']],
    limit: 5000,
  });
  return rows.map((r) => ({ ...r.toJSON(), id: String(r.id) }));
}

/** Quick "new customer" from the POS: name and phone (the code is generated). */
export async function quickCustomer(ctx, { name, phone, email }) {
  const created = await customerService.save(ctx, null, { name, phone: phone ?? null, email: email ?? null });
  return {
    id: String(created.id),
    code: created.code,
    name: created.name,
    phone: created.phone,
    email: created.email,
    customerGroupId: created.groupId,
    creditLimit: created.creditLimit,
  };
}

/**
 * Lines of lot-tracked items without a batch get batches first-expiry-first from the warehouse;
 * a line needing more than one batch is split. Fixed-amount discounts stay on the first part.
 */
export async function assignBatches(ctx, items, warehouseId, t) {
  const productIds = [...new Set(items.filter((i) => !i.batchId).map((i) => String(i.productId)))];
  if (!productIds.length) return items;
  const products = await Product.findAll({
    where: { id: productIds, companyId: ctx.auth.companyId },
    attributes: ['id', 'name', 'trackBatch', 'trackExpiry', 'baseUnitId'],
    include: [{ model: ProductUnit, as: 'units', attributes: ['unitId', 'factor'] }],
    transaction: t,
  });
  const productOf = new Map(products.map((p) => [String(p.id), p]));
  const taken = new Map();
  const out = [];
  for (const [i, item] of items.entries()) {
    const product = productOf.get(String(item.productId));
    if (item.batchId || !product || !isLotTracked(product)) {
      out.push(item);
      continue;
    }
    const unit = product.units.find((u) => String(u.unitId) === String(item.unitId));
    const factor = D(unit?.factor ?? 1);
    let need = D(item.quantity).times(factor);
    const batches = await select(
      `SELECT l.batch_id AS batchId, SUM(l.remaining) AS quantity
         FROM stock_layers l JOIN stock_batches b ON b.id = l.batch_id
        WHERE l.warehouse_id = :warehouseId AND l.product_id = :productId
          AND COALESCE(l.variant_id, 0) = :variantId AND l.remaining > 0
        GROUP BY l.batch_id, b.expiry_date
        ORDER BY b.expiry_date IS NULL, b.expiry_date, l.batch_id`,
      { warehouseId, productId: item.productId, variantId: item.variantId ?? 0 },
      t,
    );
    let first = true;
    for (const b of batches) {
      if (need.lte(0)) break;
      const key = String(b.batchId);
      const left = D(b.quantity).minus(taken.get(key) ?? 0);
      if (left.lte(0)) continue;
      const qty = left.lt(need) ? left : need;
      taken.set(key, D(taken.get(key) ?? 0).plus(qty));
      need = need.minus(qty);
      out.push({
        ...item,
        unitId: product.baseUnitId ? String(product.baseUnitId) : item.unitId,
        quantity: qty.toFixed(),
        unitPrice: item.unitPrice != null ? D(item.unitPrice).dividedBy(factor).toFixed(4) : item.unitPrice,
        discountValue: !first && item.discountType === 'amount' ? '0' : item.discountValue,
        batchId: key,
      });
      first = false;
    }
    if (need.gt(0)) throw invalid(`items.${i}.quantity`, `Not enough stock of ${product.name} in batches`);
  }
  return out;
}
