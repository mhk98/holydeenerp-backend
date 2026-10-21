import fs from 'node:fs/promises';
import path from 'node:path';
import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { env } from '../../config/env.js';
import {
  Brand,
  Product,
  ProductAttribute,
  ProductAttributeValue,
  ProductCategory,
  ProductImage,
  ProductUnit,
  ProductVariant,
  ProductVariantValue,
  StockMovement,
  TaxGroup,
  Unit,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { isValidBarcode, randomInStoreEan13 } from '../../utils/barcode.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { DOCUMENT_LINE_TABLES, assertUnused } from '../../utils/usage.js';
import { descendantIds } from '../categories/categories.service.js';
import { nextNumber } from '../sequences/sequences.service.js';

export const MAX_IMAGES = 8;

const LIST_OPTIONS = {
  sortable: ['name', 'sku', 'salePrice', 'purchasePrice', 'createdAt'],
  searchable: ['name', 'sku', 'barcode'],
  filterable: ['type', 'brandId', 'isActive', 'hasVariants'],
  defaultSort: 'name',
};

const invalid = (field, message) => AppError.unprocessable('Validation failed', [{ field, message }]);

// ── Serialisation ──────────────────────────────────────────────────────────

const listInclude = () => [
  { model: ProductCategory, as: 'category', attributes: ['id', 'name', 'code'] },
  { model: Brand, as: 'brand', attributes: ['id', 'name', 'code'] },
  { model: Unit, as: 'baseUnit', attributes: ['id', 'name', 'code', 'allowDecimal'] },
  {
    model: ProductImage,
    as: 'images',
    attributes: ['id', 'path', 'isPrimary', 'sortOrder'],
    required: false,
    where: { isPrimary: true },
  },
];

const detailInclude = () => [
  { model: ProductCategory, as: 'category', attributes: ['id', 'name', 'code'] },
  { model: Brand, as: 'brand', attributes: ['id', 'name', 'code'] },
  { model: Unit, as: 'baseUnit', attributes: ['id', 'name', 'code', 'allowDecimal'] },
  { model: TaxGroup, as: 'taxGroup', attributes: ['id', 'name', 'code'] },
  {
    model: ProductUnit,
    as: 'units',
    include: [{ model: Unit, as: 'unit', attributes: ['id', 'name', 'code'] }],
  },
  {
    model: ProductVariant,
    as: 'variants',
    include: [
      {
        model: ProductAttributeValue,
        as: 'values',
        attributes: ['id', 'value', 'attributeId'],
        through: { attributes: [] },
        include: [{ model: ProductAttribute, as: 'attribute', attributes: ['id', 'name', 'sortOrder'] }],
      },
    ],
  },
  { model: ProductImage, as: 'images', attributes: ['id', 'path', 'isPrimary', 'sortOrder'] },
];

function serialize(p, { detail = false } = {}) {
  const json = p.toJSON();
  const images = [...(json.images ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const base = {
    ...json,
    imageUrl: images.find((i) => i.isPrimary)?.path ?? images[0]?.path ?? null,
  };
  if (!detail) {
    delete base.images;
    return base;
  }
  return {
    ...base,
    images,
    units: (json.units ?? []).sort((a, b) => Number(a.factor) - Number(b.factor)),
    variants: (json.variants ?? [])
      .map((v) => ({
        ...v,
        attributeValueIds: v.values.map((x) => String(x.id)),
        values: v.values
          .sort((a, b) => a.attribute.sortOrder - b.attribute.sortOrder)
          .map((x) => ({
            id: String(x.id),
            value: x.value,
            attributeId: String(x.attributeId),
            attribute: x.attribute.name,
          })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function listProducts(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = { ...q.where, companyId: ctx.auth.companyId };
  if (query.categoryId)
    where.categoryId = { [Op.in]: await descendantIds(ctx.auth.companyId, query.categoryId) };
  // A barcode scan should also find products through their variants and packs.
  if (q.search) {
    const [variantOwners, unitOwners] = await Promise.all([
      ProductVariant.findAll({
        where: { companyId: ctx.auth.companyId, [Op.or]: [{ barcode: q.search }, { sku: q.search }] },
        attributes: ['productId'],
        raw: true,
      }),
      ProductUnit.findAll({
        where: { barcode: q.search },
        include: [
          {
            model: Product,
            as: 'product',
            attributes: [],
            where: { companyId: ctx.auth.companyId },
            required: true,
          },
        ],
        attributes: ['productId'],
        raw: true,
      }),
    ]);
    const extra = [...variantOwners, ...unitOwners].map((r) => r.productId);
    if (extra.length) where[Op.or] = [...where[Op.or], { id: { [Op.in]: extra } }];
  }
  const { rows, count } = await Product.findAndCountAll({
    where,
    include: listInclude(),
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => serialize(r)), count, page: q.page, limit: q.limit };
}

async function findProduct(ctx, id, options = {}) {
  const product = await Product.findOne({ where: { id, companyId: ctx.auth.companyId }, ...options });
  if (!product) throw AppError.notFound('Product not found');
  return product;
}

export async function getProduct(ctx, id) {
  const product = await findProduct(ctx, id, { include: detailInclude() });
  return serialize(product, { detail: true });
}

// ── Validation helpers ─────────────────────────────────────────────────────

async function assertRefs(ctx, data, t) {
  const companyId = ctx.auth.companyId;
  const checks = [
    ['categoryId', ProductCategory, 'Category'],
    ['brandId', Brand, 'Brand'],
    ['baseUnitId', Unit, 'Unit'],
    ['taxGroupId', TaxGroup, 'Tax group'],
  ];
  for (const [field, model, label] of checks) {
    if (data[field] && !(await model.count({ where: { id: data[field], companyId }, transaction: t }))) {
      throw invalid(field, `${label} not found`);
    }
  }
  const unitIds = (data.units ?? []).map((u) => u.unitId);
  if (unitIds.length) {
    if (new Set(unitIds).size !== unitIds.length) throw invalid('units', 'Each unit can only be added once');
    if (data.baseUnitId && unitIds.includes(String(data.baseUnitId))) {
      throw invalid('units', 'The base unit is already the product’s unit; add other units only');
    }
    const found = await Unit.count({ where: { id: unitIds, companyId }, transaction: t });
    if (found !== unitIds.length) throw invalid('units', 'One or more units are invalid');
  }
}

/** SKUs must be unique across products and variants (a scan or search finds exactly one item). */
async function assertSkusFree(ctx, skus, productId, t) {
  const seen = new Set();
  for (const sku of skus) {
    const key = sku.toUpperCase();
    if (seen.has(key))
      throw AppError.conflict(`SKU ${sku} is used twice in this product`, [
        { field: 'sku', message: 'Duplicate SKU' },
      ]);
    seen.add(key);
  }
  if (!skus.length) return;
  const notThis = productId ? { [Op.ne]: productId } : undefined;
  const [products, variants] = await Promise.all([
    Product.findAll({
      where: { companyId: ctx.auth.companyId, sku: skus, ...(notThis && { id: notThis }) },
      attributes: ['sku'],
      transaction: t,
    }),
    ProductVariant.findAll({
      where: { companyId: ctx.auth.companyId, sku: skus, ...(notThis && { productId: notThis }) },
      attributes: ['sku'],
      transaction: t,
    }),
  ]);
  const taken = [...products, ...variants].map((r) => r.sku);
  if (taken.length) {
    throw AppError.conflict(`SKU already in use: ${taken.join(', ')}`, [
      { field: 'sku', message: 'Already in use' },
    ]);
  }
}

/** Barcodes must be unique across products, variants and product units of the company. */
export async function assertBarcodesFree(companyId, codes, productId, t) {
  const list = codes.filter(Boolean);
  const dup = list.find((c, i) => list.indexOf(c) !== i);
  if (dup)
    throw AppError.conflict(`Barcode ${dup} is used twice in this product`, [
      { field: 'barcode', message: 'Duplicate barcode' },
    ]);
  if (!list.length) return;
  const notThis = productId ? { [Op.ne]: productId } : undefined;
  const [products, variants, units] = await Promise.all([
    Product.findAll({
      where: { companyId, barcode: list, ...(notThis && { id: notThis }) },
      attributes: ['barcode', 'name'],
      transaction: t,
    }),
    ProductVariant.findAll({
      where: { companyId, barcode: list, ...(notThis && { productId: notThis }) },
      attributes: ['barcode'],
      transaction: t,
    }),
    // Pack barcodes belong to the company through their product.
    ProductUnit.findAll({
      where: { barcode: list, ...(notThis && { productId: notThis }) },
      include: [{ model: Product, as: 'product', attributes: [], where: { companyId }, required: true }],
      attributes: ['barcode'],
      transaction: t,
    }),
  ]);
  const taken = [...products, ...variants, ...units].map((r) => r.barcode);
  if (taken.length) {
    throw AppError.conflict(`Barcode already in use: ${[...new Set(taken)].join(', ')}`, [
      { field: 'barcode', message: 'Already used by another item' },
    ]);
  }
}

function assertBarcodeFormat(code, type, field) {
  if (code && !isValidBarcode(code, type)) {
    throw invalid(
      field,
      type === 'EAN13'
        ? 'Not a valid EAN-13 (13 digits with a correct check digit)'
        : 'Use printable characters only (max 48)',
    );
  }
}

/** Load attribute values and build variant names like "Red / M". */
async function resolveVariants(ctx, variants, t) {
  const ids = [...new Set(variants.flatMap((v) => v.attributeValueIds))];
  const values = await ProductAttributeValue.findAll({
    where: { id: ids },
    include: [
      {
        model: ProductAttribute,
        as: 'attribute',
        where: { companyId: ctx.auth.companyId },
        attributes: ['id', 'name', 'sortOrder'],
      },
    ],
    transaction: t,
  });
  if (values.length !== ids.length) throw invalid('variants', 'One or more attribute values are invalid');
  const byId = new Map(values.map((v) => [String(v.id), v]));

  const combos = new Set();
  return variants.map((v, i) => {
    const vals = v.attributeValueIds.map((id) => byId.get(String(id)));
    const attributes = vals.map((x) => String(x.attributeId));
    if (new Set(attributes).size !== attributes.length) {
      throw invalid(`variants.${i}`, 'Pick at most one value per attribute');
    }
    const key = [...v.attributeValueIds].map(String).sort().join('-');
    if (combos.has(key)) throw invalid(`variants.${i}`, 'This combination already exists');
    combos.add(key);
    const ordered = vals.sort(
      (a, b) =>
        a.attribute.sortOrder - b.attribute.sortOrder || a.attribute.name.localeCompare(b.attribute.name),
    );
    return { ...v, name: ordered.map((x) => x.value).join(' / '), suffix: ordered.map((x) => x.value) };
  });
}

const skuPart = (s) =>
  String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10);

// ── Writes ─────────────────────────────────────────────────────────────────

/** A variant with stock history or on documents stays (it can be deactivated instead). */
const VARIANT_REFS = [
  { table: 'stock_movements', column: 'variant_id', label: 'stock movement' },
  ...[...DOCUMENT_LINE_TABLES, 'stock_count_items'].map((table) => ({
    table,
    column: 'variant_id',
    label: 'document line',
  })),
];
const assertVariantUnused = (variant, t) =>
  assertUnused(variant.id, VARIANT_REFS, {
    what: `Variant ${variant.name}`,
    hint: 'keep it and mark it inactive instead',
    transaction: t,
  });

async function writeChildren(ctx, product, data, t) {
  if (data.units) {
    await ProductUnit.destroy({ where: { productId: product.id }, transaction: t });
    const firstDefault = (key) => data.units.findIndex((u) => u[key]);
    const dp = firstDefault('isDefaultPurchase');
    const ds = firstDefault('isDefaultSale');
    await ProductUnit.bulkCreate(
      data.units.map((u, i) => ({
        productId: product.id,
        unitId: u.unitId,
        factor: u.factor,
        barcode: u.barcode,
        purchasePrice: u.purchasePrice ?? null,
        salePrice: u.salePrice ?? null,
        isDefaultPurchase: i === dp,
        isDefaultSale: i === ds,
      })),
      { transaction: t },
    );
  }

  if (!product.hasVariants) {
    const old = await ProductVariant.findAll({ where: { productId: product.id }, transaction: t });
    for (const v of old) {
      await assertVariantUnused(v, t);
      await v.update({ sku: retiredValue(v.sku, v.id, 60), barcode: null }, { transaction: t });
      await v.destroy({ transaction: t });
    }
    return;
  }

  if (!data.variants) return;
  const resolved = data.resolvedVariants;
  const existing = await ProductVariant.findAll({ where: { productId: product.id }, transaction: t });
  const keep = new Set();
  for (const v of resolved) {
    const row = {
      companyId: product.companyId,
      productId: product.id,
      sku: v.sku,
      barcode: v.barcode,
      name: v.name,
      purchasePrice: v.purchasePrice ?? null,
      salePrice: v.salePrice ?? null,
      isActive: v.isActive ?? true,
      updatedBy: ctx.auth.userId,
    };
    let variant = v.id && existing.find((e) => String(e.id) === String(v.id));
    if (variant) await variant.update(row, { transaction: t });
    else variant = await ProductVariant.create({ ...row, createdBy: ctx.auth.userId }, { transaction: t });
    keep.add(String(variant.id));
    await ProductVariantValue.destroy({ where: { variantId: variant.id }, transaction: t });
    await ProductVariantValue.bulkCreate(
      v.attributeValueIds.map((id) => ({ variantId: variant.id, attributeValueId: id })),
      { transaction: t },
    );
  }
  for (const old of existing.filter((e) => !keep.has(String(e.id)))) {
    await assertVariantUnused(old, t);
    await old.update({ sku: retiredValue(old.sku, old.id, 60), barcode: null }, { transaction: t });
    await old.destroy({ transaction: t });
  }
}

/** Create or update a product with its units and variants in one transaction. */
export async function saveProduct(ctx, id, input) {
  const productId = await sequelize.transaction(async (t) => {
    const existing = id ? await findProduct(ctx, id, { transaction: t, lock: t.LOCK.UPDATE }) : null;
    const data = { ...input };
    await assertRefs(ctx, data, t);

    data.sku = data.sku?.trim() || existing?.sku;
    if (!data.sku)
      data.sku = await nextNumber({ companyId: ctx.auth.companyId, docType: 'product_sku', transaction: t });
    const barcodeType = data.barcodeType ?? existing?.barcodeType ?? 'CODE128';
    assertBarcodeFormat(data.barcode, barcodeType, 'barcode');
    data.units?.forEach((u, i) =>
      assertBarcodeFormat(
        u.barcode,
        /^\d{13}$/.test(u.barcode ?? '') ? 'EAN13' : 'CODE128',
        `units.${i}.barcode`,
      ),
    );

    const hasVariants = data.hasVariants ?? existing?.hasVariants ?? false;
    if (hasVariants && data.variants !== undefined && data.variants.length === 0) {
      throw invalid('variants', 'Add at least one variant or turn variants off');
    }
    if (hasVariants && data.variants) {
      data.resolvedVariants = (await resolveVariants(ctx, data.variants, t)).map((v) => ({
        ...v,
        sku: v.sku?.trim() || `${data.sku}-${v.suffix.map(skuPart).join('-')}`,
      }));
      data.resolvedVariants.forEach((v, i) =>
        assertBarcodeFormat(
          v.barcode,
          /^\d{13}$/.test(v.barcode ?? '') ? 'EAN13' : 'CODE128',
          `variants.${i}.barcode`,
        ),
      );
    }

    await assertSkusFree(
      ctx,
      [data.sku, ...(data.resolvedVariants ?? []).map((v) => v.sku)],
      existing?.id,
      t,
    );
    await assertBarcodesFree(
      ctx.auth.companyId,
      [
        data.barcode,
        ...(data.units ?? []).map((u) => u.barcode),
        ...(data.resolvedVariants ?? []).map((v) => v.barcode),
      ],
      existing?.id,
      t,
    );

    // Child rows are written by writeChildren(); keep only product columns here.
    const fields = { ...data };
    delete fields.units;
    delete fields.variants;
    delete fields.resolvedVariants;
    let product;
    if (existing) {
      await existing.update(
        { ...fields, barcodeType, hasVariants, updatedBy: ctx.auth.userId },
        { transaction: t },
      );
      product = existing;
    } else {
      product = await Product.create(
        {
          ...fields,
          barcodeType,
          hasVariants,
          companyId: ctx.auth.companyId,
          createdBy: ctx.auth.userId,
          updatedBy: ctx.auth.userId,
        },
        { transaction: t },
      );
    }
    await writeChildren(ctx, product, data, t);
    return product.id;
  });
  return getProduct(ctx, productId);
}

export async function deleteProduct(ctx, id) {
  await sequelize.transaction(async (t) => {
    const product = await findProduct(ctx, id, { transaction: t, lock: t.LOCK.UPDATE });
    // The ledger references the product forever; deactivate it instead.
    if (await StockMovement.count({ where: { productId: product.id }, transaction: t })) {
      throw AppError.conflict(
        'This product has stock history and cannot be deleted; mark it inactive instead',
      );
    }
    // Documents without stock (quotations, orders, bills of services) keep it too.
    await assertUnused(
      product.id,
      DOCUMENT_LINE_TABLES.map((table) => ({ table, column: 'product_id', label: 'document line' })),
      { what: 'This product', hint: 'mark it inactive instead', transaction: t },
    );
    const variants = await ProductVariant.findAll({ where: { productId: product.id }, transaction: t });
    for (const v of variants) {
      await v.update({ sku: retiredValue(v.sku, v.id, 60), barcode: null }, { transaction: t });
      await v.destroy({ transaction: t });
    }
    await ProductUnit.update({ barcode: null }, { where: { productId: product.id }, transaction: t });
    await product.update(
      { sku: retiredValue(product.sku, product.id, 60), barcode: null, updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    await product.destroy({ transaction: t });
  });
}

// ── Barcodes ───────────────────────────────────────────────────────────────

/** Suggest a free barcode: a random in-store EAN-13, or CODE128 from the SKU. */
export async function generateBarcode(ctx, { type, sku }) {
  if (type === 'CODE128') {
    if (!sku) throw invalid('sku', 'Enter the SKU first');
    const code = sku.toUpperCase();
    await assertBarcodesFree(ctx.auth.companyId, [code], null);
    return { barcode: code, type };
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomInStoreEan13();
    try {
      await assertBarcodesFree(ctx.auth.companyId, [code], null);
      return { barcode: code, type };
    } catch {
      // collision — try another
    }
  }
  throw new AppError('Could not generate a unique barcode, try again', 500);
}

/** Everything the label printer needs for the selected products (and their variants). */
export async function labelData(ctx, ids) {
  const products = await Product.findAll({
    where: { id: ids, companyId: ctx.auth.companyId },
    include: [
      {
        model: ProductVariant,
        as: 'variants',
        attributes: ['id', 'sku', 'barcode', 'name', 'salePrice', 'isActive'],
      },
    ],
    attributes: ['id', 'sku', 'name', 'barcode', 'barcodeType', 'salePrice', 'hasVariants'],
  });
  return products.map((p) => p.toJSON());
}

// ── Images ─────────────────────────────────────────────────────────────────

const uploadsRoot = () => path.resolve(env.ROOT_DIR, env.UPLOAD_DIR);
async function removeFile(publicUrl) {
  if (!publicUrl?.startsWith('/uploads/')) return;
  const file = path.resolve(uploadsRoot(), publicUrl.slice('/uploads/'.length));
  if (file.startsWith(uploadsRoot())) await fs.unlink(file).catch(() => {});
}

export async function addImages(ctx, id, files) {
  if (!files?.length) throw AppError.badRequest('Please choose at least one image');
  const product = await findProduct(ctx, id);
  const existing = await ProductImage.count({ where: { productId: product.id } });
  if (existing + files.length > MAX_IMAGES) {
    await Promise.all(files.map((f) => removeFile(`/uploads/products/${f.filename}`)));
    throw AppError.badRequest(`A product can have at most ${MAX_IMAGES} images`);
  }
  await ProductImage.bulkCreate(
    files.map((f, i) => ({
      productId: product.id,
      path: `/uploads/products/${f.filename}`,
      sortOrder: existing + i,
      isPrimary: existing === 0 && i === 0,
    })),
  );
  return getProduct(ctx, id);
}

export async function deleteImage(ctx, id, imageId) {
  const product = await findProduct(ctx, id);
  const image = await ProductImage.findOne({ where: { id: imageId, productId: product.id } });
  if (!image) throw AppError.notFound('Image not found');
  await image.destroy();
  await removeFile(image.path);
  if (image.isPrimary) {
    const next = await ProductImage.findOne({
      where: { productId: product.id },
      order: [['sortOrder', 'ASC']],
    });
    if (next) await next.update({ isPrimary: true });
  }
  return getProduct(ctx, id);
}

/** Reorder images; the first becomes the primary image. */
export async function orderImages(ctx, id, imageIds) {
  const product = await findProduct(ctx, id);
  await sequelize.transaction(async (t) => {
    const images = await ProductImage.findAll({ where: { productId: product.id }, transaction: t });
    if (
      images.length !== imageIds.length ||
      !imageIds.every((i) => images.some((img) => String(img.id) === String(i)))
    ) {
      throw invalid('imageIds', 'Send every image id of this product exactly once');
    }
    for (const [i, imageId] of imageIds.entries()) {
      await ProductImage.update(
        { sortOrder: i, isPrimary: i === 0 },
        { where: { id: imageId }, transaction: t },
      );
    }
  });
  return getProduct(ctx, id);
}

/**
 * Pickers for the product form (units, tax groups) — readable with products.view, so users
 * without settings access can still create products.
 */
export async function productLookups(ctx) {
  const where = { companyId: ctx.auth.companyId, isActive: true };
  const [units, taxGroups] = await Promise.all([
    Unit.findAll({
      where,
      attributes: ['id', 'name', 'code', 'category', 'allowDecimal'],
      order: [['name', 'ASC']],
    }),
    TaxGroup.findAll({ where, attributes: ['id', 'name', 'code'], order: [['name', 'ASC']] }),
  ]);
  return { units, taxGroups };
}
