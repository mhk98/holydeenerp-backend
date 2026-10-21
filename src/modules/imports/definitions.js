import {
  Brand,
  Party,
  PartyAddress,
  PartyGroup,
  Product,
  ProductCategory,
  TaxGroup,
  Unit,
} from '../../models.js';
import { parseBool, yesNo } from '../../utils/excel.js';
import { brandCrud } from '../brands/brands.service.js';
import { createBrandSchema } from '../brands/brands.validation.js';
import { categoryCrud } from '../categories/categories.service.js';
import { createCategorySchema } from '../categories/categories.validation.js';
import { customers, suppliers } from '../parties/parties.service.js';
import { partySchema } from '../parties/parties.validation.js';
import { PRODUCT_TYPES } from '../products/product.model.js';
import { saveProduct } from '../products/products.service.js';
import { productSchema } from '../products/products.validation.js';
import { zodMessages } from './import.service.js';

/** code → id map, keys upper-cased for case-insensitive lookups. */
async function codeMap(model, where, key = 'code') {
  const rows = await model.findAll({ where, attributes: ['id', key], raw: true });
  return new Map(rows.map((r) => [String(r[key]).toUpperCase(), String(r.id)]));
}

const blank = (v) => v === undefined || v === '';
const orUndefined = (v) => (blank(v) ? undefined : v);

/** Map a lookup column ("category_code") to an id, collecting a readable error. */
function lookup(map, value, header, errors) {
  if (blank(value)) return null;
  const id = map.get(String(value).toUpperCase());
  if (!id) errors.push(`${header}: "${value}" not found`);
  return id ?? null;
}

function bool(value, header, errors) {
  const parsed = parseBool(value);
  if (parsed === null) errors.push(`${header}: use yes or no`);
  return parsed ?? undefined;
}

// ── Products ───────────────────────────────────────────────────────────────

const productColumns = [
  {
    key: 'sku',
    header: 'SKU',
    note: 'Leave empty to generate. Existing SKU = update that product.',
    width: 16,
  },
  { key: 'name', header: 'Name', required: true, width: 34 },
  {
    key: 'type',
    header: 'Type',
    note: `One of: ${PRODUCT_TYPES.join(', ')}. Default finished_good.`,
    width: 16,
  },
  { key: 'category', header: 'Category code', note: 'Code of an existing category.' },
  { key: 'brand', header: 'Brand code' },
  { key: 'unit', header: 'Unit', required: true, note: 'Unit code, e.g. pcs, kg, ltr.' },
  { key: 'purchasePrice', header: 'Purchase price' },
  { key: 'salePrice', header: 'Sale price' },
  { key: 'taxGroup', header: 'Tax group code', note: 'e.g. STD for VAT 15%.' },
  { key: 'priceIncludesTax', header: 'Price includes tax', note: 'yes / no' },
  { key: 'reorderLevel', header: 'Reorder level' },
  { key: 'barcode', header: 'Barcode' },
  { key: 'barcodeType', header: 'Barcode type', note: 'EAN13 or CODE128 (default CODE128).' },
  { key: 'trackBatch', header: 'Track batch', note: 'yes / no' },
  { key: 'trackSerial', header: 'Track serial', note: 'yes / no' },
  { key: 'trackExpiry', header: 'Track expiry', note: 'yes / no' },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'isActive', header: 'Active', note: 'yes / no (default yes)' },
];
const header = (columns) => Object.fromEntries(columns.map((c) => [c.key, c.header]));
const productHeaders = {
  ...header(productColumns),
  baseUnitId: 'Unit',
  categoryId: 'Category code',
  brandId: 'Brand code',
  taxGroupId: 'Tax group code',
};

export const productImport = {
  entity: 'products',
  sheetName: 'Products',
  columns: productColumns,
  examples: [
    {
      sku: '',
      name: 'Miniket Rice 5 kg',
      type: 'finished_good',
      category: 'RICE',
      brand: 'ACI',
      unit: 'pcs',
      purchasePrice: 360,
      salePrice: 410,
      taxGroup: 'EXEMPT',
      priceIncludesTax: 'no',
      reorderLevel: 20,
      barcode: '',
      barcodeType: 'CODE128',
      trackBatch: 'no',
      trackSerial: 'no',
      trackExpiry: 'yes',
      description: '',
      isActive: 'yes',
    },
  ],
  instructions: [
    'One row per product. Variants and extra units are managed in the product form, not in this file.',
    'Rows with an SKU that already exists update that product; other rows create new products.',
    'Prices and quantities: plain numbers without currency symbols or thousands separators.',
  ],
  async prepare(ctx) {
    const companyId = ctx.auth.companyId;
    const [categories, brands, units, taxGroups, products] = await Promise.all([
      codeMap(ProductCategory, { companyId }),
      codeMap(Brand, { companyId }),
      codeMap(Unit, { companyId }),
      codeMap(TaxGroup, { companyId }),
      codeMap(Product, { companyId }, 'sku'),
    ]);
    return { categories, brands, units, taxGroups, products };
  },
  async validateRow(ctx, v, lk) {
    const errors = [];
    const type = blank(v.type)
      ? 'finished_good'
      : String(v.type)
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
    const payload = {
      sku: orUndefined(v.sku),
      name: v.name,
      type,
      categoryId: lookup(lk.categories, v.category, 'Category code', errors),
      brandId: lookup(lk.brands, v.brand, 'Brand code', errors),
      baseUnitId: lookup(lk.units, v.unit, 'Unit', errors) ?? undefined,
      purchasePrice: orUndefined(v.purchasePrice),
      salePrice: orUndefined(v.salePrice),
      taxGroupId: lookup(lk.taxGroups, v.taxGroup, 'Tax group code', errors),
      priceIncludesTax: bool(v.priceIncludesTax, 'Price includes tax', errors),
      reorderLevel: orUndefined(v.reorderLevel),
      barcode: orUndefined(v.barcode),
      barcodeType: blank(v.barcodeType) ? undefined : String(v.barcodeType).toUpperCase(),
      trackBatch: bool(v.trackBatch, 'Track batch', errors),
      trackSerial: bool(v.trackSerial, 'Track serial', errors),
      trackExpiry: bool(v.trackExpiry, 'Track expiry', errors),
      description: orUndefined(v.description),
      isActive: bool(v.isActive, 'Active', errors),
    };
    const parsed = productSchema.safeParse(payload);
    if (!parsed.success) errors.push(...zodMessages(parsed.error, productHeaders));
    const existingId = payload.sku ? lk.products.get(payload.sku.toUpperCase()) : undefined;
    return { payload: parsed.success ? parsed.data : payload, existingId, key: payload.sku, errors };
  },
  save: (ctx, payload, existingId) => saveProduct(ctx, existingId ?? null, payload),
  async exportRecords(ctx) {
    const rows = await Product.findAll({
      where: { companyId: ctx.auth.companyId },
      include: ['category', 'brand', 'baseUnit', 'taxGroup'],
      order: [['name', 'ASC']],
    });
    return rows.map((p) => ({
      sku: p.sku,
      name: p.name,
      type: p.type,
      category: p.category?.code ?? '',
      brand: p.brand?.code ?? '',
      unit: p.baseUnit?.code ?? '',
      purchasePrice: Number(p.purchasePrice),
      salePrice: Number(p.salePrice),
      taxGroup: p.taxGroup?.code ?? '',
      priceIncludesTax: yesNo(p.priceIncludesTax),
      reorderLevel: Number(p.reorderLevel),
      barcode: p.barcode ?? '',
      barcodeType: p.barcodeType,
      trackBatch: yesNo(p.trackBatch),
      trackSerial: yesNo(p.trackSerial),
      trackExpiry: yesNo(p.trackExpiry),
      description: p.description ?? '',
      isActive: yesNo(p.isActive),
    }));
  },
};

// ── Categories ─────────────────────────────────────────────────────────────

const categoryColumns = [
  { key: 'code', header: 'Code', required: true },
  { key: 'name', header: 'Name', required: true, width: 30 },
  {
    key: 'parent',
    header: 'Parent code',
    note: 'Code of the parent category (in the database or earlier/later in this file).',
  },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'sortOrder', header: 'Sort order' },
  { key: 'isActive', header: 'Active', note: 'yes / no' },
];

export const categoryImport = {
  entity: 'categories',
  sheetName: 'Categories',
  columns: categoryColumns,
  examples: [
    { code: 'GROCERY', name: 'Grocery', parent: '', sortOrder: 1, isActive: 'yes' },
    { code: 'RICE', name: 'Rice', parent: 'GROCERY', sortOrder: 1, isActive: 'yes' },
  ],
  instructions: ['Parents are created before their sub-categories, whatever the row order.'],
  async prepare(ctx, rows) {
    return {
      codes: await codeMap(ProductCategory, { companyId: ctx.auth.companyId }),
      inFile: new Set(rows.map((r) => String(r.values.code).toUpperCase()).filter(Boolean)),
    };
  },
  /** Parents first; a cycle (A → B → A) is left in place and reported by validateRow. */
  order(rows) {
    const byCode = new Map(rows.map((r) => [String(r.values.code).toUpperCase(), r]));
    const out = [];
    const state = new Map();
    const visit = (row, depth = 0) => {
      const code = String(row.values.code).toUpperCase();
      if (state.get(code) === 'done' || depth > 50) return;
      if (state.get(code) === 'visiting') return;
      state.set(code, 'visiting');
      const parent = byCode.get(String(row.values.parent ?? '').toUpperCase());
      if (parent && parent !== row) visit(parent, depth + 1);
      state.set(code, 'done');
      out.push(row);
    };
    rows.forEach((r) => visit(r));
    return out;
  },
  async validateRow(ctx, v, lk) {
    const errors = [];
    const parentCode = String(v.parent ?? '').toUpperCase();
    if (parentCode && !lk.codes.has(parentCode) && !lk.inFile.has(parentCode))
      errors.push(`Parent code: "${v.parent}" not found`);
    if (parentCode && parentCode === String(v.code).toUpperCase())
      errors.push('Parent code: a category cannot be its own parent');
    const payload = {
      code: v.code,
      name: v.name,
      description: orUndefined(v.description),
      sortOrder: blank(v.sortOrder) ? undefined : Number(v.sortOrder),
      isActive: bool(v.isActive, 'Active', errors),
      parentCode: parentCode || null,
    };
    const parsed = createCategorySchema.safeParse(payload);
    if (!parsed.success) errors.push(...zodMessages(parsed.error, header(categoryColumns)));
    return {
      payload: { ...(parsed.success ? parsed.data : payload), parentCode: payload.parentCode },
      existingId: lk.codes.get(String(v.code).toUpperCase()),
      key: v.code,
      errors,
    };
  },
  async save(ctx, { parentCode, ...payload }, existingId, lk) {
    const data = { ...payload, parentId: parentCode ? (lk.codes.get(parentCode) ?? null) : null };
    const saved = existingId
      ? await categoryCrud.update(ctx, existingId, data)
      : await categoryCrud.create(ctx, data);
    lk.codes.set(String(saved.code).toUpperCase(), String(saved.id));
  },
  async exportRecords(ctx) {
    const rows = await ProductCategory.findAll({
      where: { companyId: ctx.auth.companyId },
      include: [{ model: ProductCategory, as: 'parent', attributes: ['code'] }],
      order: [['code', 'ASC']],
    });
    return rows.map((c) => ({
      code: c.code,
      name: c.name,
      parent: c.parent?.code ?? '',
      description: c.description ?? '',
      sortOrder: c.sortOrder,
      isActive: yesNo(c.isActive),
    }));
  },
};

// ── Brands ─────────────────────────────────────────────────────────────────

const brandColumns = [
  { key: 'code', header: 'Code', required: true },
  { key: 'name', header: 'Name', required: true, width: 30 },
  { key: 'description', header: 'Description', width: 40 },
  { key: 'isActive', header: 'Active', note: 'yes / no' },
];

export const brandImport = {
  entity: 'brands',
  sheetName: 'Brands',
  columns: brandColumns,
  examples: [{ code: 'PRAN', name: 'PRAN', description: 'PRAN-RFL Group', isActive: 'yes' }],
  instructions: [],
  prepare: async (ctx) => ({ codes: await codeMap(Brand, { companyId: ctx.auth.companyId }) }),
  async validateRow(ctx, v, lk) {
    const errors = [];
    const payload = {
      code: v.code,
      name: v.name,
      description: orUndefined(v.description),
      isActive: bool(v.isActive, 'Active', errors),
    };
    const parsed = createBrandSchema.safeParse(payload);
    if (!parsed.success) errors.push(...zodMessages(parsed.error, header(brandColumns)));
    return {
      payload: parsed.success ? parsed.data : payload,
      existingId: lk.codes.get(String(v.code).toUpperCase()),
      key: v.code,
      errors,
    };
  },
  save: (ctx, payload, existingId) =>
    existingId ? brandCrud.update(ctx, existingId, payload) : brandCrud.create(ctx, payload),
  async exportRecords(ctx) {
    const rows = await Brand.findAll({ where: { companyId: ctx.auth.companyId }, order: [['name', 'ASC']] });
    return rows.map((b) => ({
      code: b.code,
      name: b.name,
      description: b.description ?? '',
      isActive: yesNo(b.isActive),
    }));
  },
};

// ── Customers & suppliers ──────────────────────────────────────────────────

const partyColumns = [
  { key: 'code', header: 'Code', note: 'Leave empty to generate. Existing code = update.' },
  { key: 'name', header: 'Name', required: true, width: 30 },
  { key: 'contactPerson', header: 'Contact person', width: 20 },
  { key: 'phone', header: 'Phone' },
  { key: 'email', header: 'Email', width: 24 },
  { key: 'binNo', header: 'BIN' },
  { key: 'tinNo', header: 'TIN' },
  { key: 'group', header: 'Group code' },
  { key: 'creditLimit', header: 'Credit limit', note: '0 = no limit' },
  { key: 'paymentTermsDays', header: 'Payment terms (days)' },
  { key: 'openingBalance', header: 'Opening balance' },
  {
    key: 'openingBalanceType',
    header: 'Opening balance type',
    note: 'debit (they owe us) or credit (we owe them)',
  },
  {
    key: 'address',
    header: 'Address',
    width: 36,
    note: 'Replaces the saved addresses with this one (billing, default).',
  },
  { key: 'city', header: 'City' },
  { key: 'district', header: 'District' },
  { key: 'postalCode', header: 'Postal code' },
  { key: 'isActive', header: 'Active', note: 'yes / no' },
];

function partyImport(type) {
  const service = type === 'customer' ? customers : suppliers;
  const flag = type === 'customer' ? 'isCustomer' : 'isSupplier';
  return {
    entity: `${type}s`,
    sheetName: type === 'customer' ? 'Customers' : 'Suppliers',
    columns: partyColumns,
    examples: [
      type === 'customer'
        ? {
            code: '',
            name: 'Shapla Super Shop',
            contactPerson: 'Md. Jahid Hasan',
            phone: '01712-345678',
            email: '',
            binNo: '',
            tinNo: '',
            group: 'RETAIL',
            creditLimit: 50000,
            paymentTermsDays: 15,
            openingBalance: 0,
            openingBalanceType: 'debit',
            address: 'House 12, Road 5, Dhanmondi',
            city: 'Dhaka',
            district: 'Dhaka',
            postalCode: '1205',
            isActive: 'yes',
          }
        : {
            code: '',
            name: 'Meghna Group of Industries',
            contactPerson: 'Sales desk',
            phone: '09612-000000',
            group: 'LOCAL',
            creditLimit: 0,
            paymentTermsDays: 30,
            openingBalance: 0,
            openingBalanceType: 'credit',
            address: 'Meghna Ghat, Sonargaon',
            city: 'Narayanganj',
            district: 'Narayanganj',
            isActive: 'yes',
          },
    ],
    instructions: ['Rows whose code already exists update that record; other rows create new ones.'],
    async prepare(ctx) {
      const companyId = ctx.auth.companyId;
      return {
        groups: await codeMap(PartyGroup, { companyId, type }),
        codes: await codeMap(Party, { companyId, [flag]: true }),
      };
    },
    async validateRow(ctx, v, lk) {
      const errors = [];
      const payload = {
        code: orUndefined(v.code),
        name: v.name,
        contactPerson: orUndefined(v.contactPerson),
        phone: orUndefined(v.phone),
        email: orUndefined(v.email),
        binNo: orUndefined(v.binNo),
        tinNo: orUndefined(v.tinNo),
        groupId: lookup(lk.groups, v.group, 'Group code', errors),
        creditLimit: orUndefined(v.creditLimit),
        paymentTermsDays: orUndefined(v.paymentTermsDays),
        openingBalance: orUndefined(v.openingBalance),
        openingBalanceType: blank(v.openingBalanceType)
          ? undefined
          : String(v.openingBalanceType).toLowerCase(),
        isActive: bool(v.isActive, 'Active', errors),
        ...(!blank(v.address) && {
          addresses: [
            {
              type: 'billing',
              addressLine: v.address,
              city: orUndefined(v.city),
              district: orUndefined(v.district),
              postalCode: orUndefined(v.postalCode),
              isDefault: true,
            },
          ],
        }),
      };
      const parsed = partySchema.safeParse(payload);
      if (!parsed.success)
        errors.push(
          ...zodMessages(parsed.error, {
            ...header(partyColumns),
            groupId: 'Group code',
            addresses: 'Address',
          }),
        );
      const existingId = payload.code ? lk.codes.get(String(payload.code).toUpperCase()) : undefined;
      return { payload: parsed.success ? parsed.data : payload, existingId, key: payload.code, errors };
    },
    save: (ctx, payload, existingId) => service.save(ctx, existingId ?? null, payload),
    async exportRecords(ctx) {
      const groupAs = type === 'customer' ? 'customerGroup' : 'supplierGroup';
      const rows = await Party.findAll({
        where: { companyId: ctx.auth.companyId, [flag]: true },
        include: [
          { model: PartyGroup, as: groupAs, attributes: ['code'] },
          { model: PartyAddress, as: 'addresses' },
        ],
        order: [['code', 'ASC']],
      });
      return rows.map((p) => {
        const address = p.addresses.find((a) => a.isDefault) ?? p.addresses[0];
        return {
          code: p.code,
          name: p.name,
          contactPerson: p.contactPerson ?? '',
          phone: p.phone ?? '',
          email: p.email ?? '',
          binNo: p.binNo ?? '',
          tinNo: p.tinNo ?? '',
          group: p[groupAs]?.code ?? '',
          creditLimit: Number(p.creditLimit),
          paymentTermsDays: p.paymentTermsDays,
          openingBalance: Number(p.openingBalance),
          openingBalanceType: p.openingBalanceType,
          address: address?.addressLine ?? '',
          city: address?.city ?? '',
          district: address?.district ?? '',
          postalCode: address?.postalCode ?? '',
          isActive: yesNo(p.isActive),
        };
      });
    },
  };
}

export const customerImport = partyImport('customer');
export const supplierImport = partyImport('supplier');
