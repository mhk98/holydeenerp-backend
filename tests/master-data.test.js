import ExcelJS from 'exceljs';
import { closeDatabase } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

let admin;
let storekeeper;
let cashier;
let accountant;

beforeAll(async () => {
  [admin, storekeeper, cashier, accountant] = await Promise.all([
    login('admin@holydeen.com'),
    login('storekeeper@holydeen.com'),
    login('cashier@holydeen.com'),
    login('accountant@holydeen.com'),
  ]);
});
afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
});

const as = (user) => ({
  get: (u) => api().get(u).set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
  upload: (u, field, buffer, filename) =>
    api().post(u).set(bearer(user.token)).attach(field, buffer, filename),
});

/** Binary (xlsx) responses for supertest. */
const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function xlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const lookups = {};
async function idOf(path, field, value) {
  const key = `${path}:${value}`;
  if (!lookups[key]) {
    const res = await as(admin).get(`${path}?search=${encodeURIComponent(value)}&limit=50`);
    lookups[key] = res.body.data.find((r) => r[field] === value)?.id;
  }
  return lookups[key];
}
const unitId = (code) => idOf('/api/v1/settings/units', 'code', code);

// 1×1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('access', () => {
  it('applies products.* / sales.* / purchase.* permissions', async () => {
    expect((await as(cashier).get('/api/v1/products')).status).toBe(200);
    expect((await as(cashier).send('post', '/api/v1/brands', { name: 'X', code: 'X' })).status).toBe(403);
    expect((await as(cashier).get('/api/v1/customers')).status).toBe(200);
    expect((await as(cashier).get('/api/v1/suppliers')).status).toBe(403);
    expect((await as(accountant).get('/api/v1/suppliers')).status).toBe(200);
    expect((await as(accountant).send('post', '/api/v1/suppliers', { name: 'X' })).status).toBe(403);
    expect((await api().get('/api/v1/products')).status).toBe(401);

    // product form pickers without settings access
    const lookups = await as(storekeeper).get('/api/v1/products/lookups');
    expect(lookups.status).toBe(200);
    expect(lookups.body.data.units.map((u) => u.code)).toEqual(
      expect.arrayContaining(['pcs', 'kg', 'carton']),
    );
    expect(lookups.body.data.taxGroups.map((g) => g.code)).toContain('STD');
    expect((await as(storekeeper).get('/api/v1/settings/units')).status).toBe(403);
  });
});

describe('categories', () => {
  it('returns the seeded tree with product counts', async () => {
    const res = await as(admin).get('/api/v1/product-categories/tree');
    expect(res.status).toBe(200);
    const grocery = res.body.data.find((c) => c.code === 'GROCERY');
    expect(grocery.children.map((c) => c.code)).toEqual(expect.arrayContaining(['RICE', 'OIL', 'PULSES']));
    expect(grocery.children.find((c) => c.code === 'RICE').productCount).toBe(2);
  });

  it('prevents cycles, blocks deleting used categories and moves nodes', async () => {
    const parent = await as(admin).send('post', '/api/v1/product-categories', {
      name: 'Frozen Food',
      code: 'frozen',
    });
    expect(parent.status).toBe(201);
    expect(parent.body.data.code).toBe('FROZEN');
    const child = await as(admin).send('post', '/api/v1/product-categories', {
      name: 'Frozen Fish',
      code: 'FISH',
      parentId: parent.body.data.id,
    });
    expect(child.status).toBe(201);

    const cycle = await as(admin).send('patch', `/api/v1/product-categories/${parent.body.data.id}`, {
      parentId: child.body.data.id,
    });
    expect(cycle.status).toBe(422);

    const dup = await as(admin).send('post', '/api/v1/product-categories', { name: 'Dup', code: 'FISH' });
    expect(dup.status).toBe(409);

    // has children → blocked
    expect((await as(admin).send('delete', `/api/v1/product-categories/${parent.body.data.id}`)).status).toBe(
      409,
    );
    // has products → blocked
    const rice = await idOf('/api/v1/product-categories', 'code', 'RICE');
    expect((await as(admin).send('delete', `/api/v1/product-categories/${rice}`)).status).toBe(409);

    // drag the child to the root
    const moved = await as(admin).send('post', '/api/v1/product-categories/move', {
      items: [{ id: child.body.data.id, parentId: null, sortOrder: 99 }],
    });
    expect(moved.status).toBe(200);
    const tree = await as(admin).get('/api/v1/product-categories/tree');
    expect(tree.body.data.some((c) => c.code === 'FISH')).toBe(true);

    expect((await as(admin).send('delete', `/api/v1/product-categories/${parent.body.data.id}`)).status).toBe(
      200,
    );
    // the code is free again after deletion
    const again = await as(admin).send('post', '/api/v1/product-categories', {
      name: 'Frozen',
      code: 'FROZEN',
    });
    expect(again.status).toBe(201);
  });
});

describe('brands and attributes', () => {
  it('blocks deleting a brand in use and uploads a logo', async () => {
    const aci = await idOf('/api/v1/brands', 'code', 'ACI');
    expect((await as(admin).send('delete', `/api/v1/brands/${aci}`)).status).toBe(409);

    const brand = await as(admin).send('post', '/api/v1/brands', {
      name: 'Bashundhara',
      code: 'BASHUNDHARA',
    });
    expect(brand.status).toBe(201);
    const logo = await as(admin).upload(`/api/v1/brands/${brand.body.data.id}/logo`, 'logo', PNG, 'logo.png');
    expect(logo.status).toBe(200);
    expect(logo.body.data.logoUrl).toMatch(/\/uploads\/brands\//);
    expect((await as(admin).send('delete', `/api/v1/brands/${brand.body.data.id}`)).status).toBe(200);
  });

  it('keeps attribute values used by variants', async () => {
    const list = await as(admin).get('/api/v1/product-attributes?search=Size');
    const size = list.body.data.find((a) => a.name === 'Size');
    const removeM = await as(admin).send('patch', `/api/v1/product-attributes/${size.id}`, {
      values: ['S', 'L', 'XL'],
    });
    expect(removeM.status).toBe(409);
    const add = await as(admin).send('patch', `/api/v1/product-attributes/${size.id}`, {
      values: ['S', 'M', 'L', 'XL', 'XXL'],
    });
    expect(add.status).toBe(200);
    expect(add.body.data.values.map((v) => v.value)).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
  });
});

describe('products', () => {
  let productId;
  let base;

  beforeAll(async () => {
    base = {
      name: 'Holydeen Mustard Oil 1 L',
      type: 'finished_good',
      baseUnitId: await unitId('pcs'),
      categoryId: await idOf('/api/v1/product-categories', 'code', 'OIL'),
      purchasePrice: '210',
      salePrice: '245.50',
      trackBatch: true,
    };
  });

  it('creates a product with a generated SKU, barcode and packs', async () => {
    const gen = await as(admin).get('/api/v1/products/barcode/generate?type=EAN13');
    expect(gen.status).toBe(200);
    expect(gen.body.data.barcode).toMatch(/^2\d{12}$/);

    const res = await as(admin).send('post', '/api/v1/products', {
      ...base,
      barcode: gen.body.data.barcode,
      barcodeType: 'EAN13',
      units: [{ unitId: await unitId('carton'), factor: '12', salePrice: '2900', isDefaultPurchase: true }],
    });
    expect(res.status).toBe(201);
    productId = res.body.data.id;
    expect(res.body.data.sku).toMatch(/^P-\d{6}$/);
    expect(res.body.data.salePrice).toBe('245.5000');
    expect(res.body.data.units).toHaveLength(1);
    expect(res.body.data.units[0]).toMatchObject({ factor: '12.000000', isDefaultPurchase: true });
  });

  it('rejects invalid and duplicate barcodes / SKUs', async () => {
    const badEan = await as(admin).send('post', '/api/v1/products', {
      ...base,
      barcode: '1234567890123',
      barcodeType: 'EAN13',
    });
    expect(badEan.status).toBe(422);

    const seeded = await as(admin).get('/api/v1/products?search=Teer');
    const teer = seeded.body.data[0];
    const dupBarcode = await as(admin).send('post', '/api/v1/products', {
      ...base,
      barcode: teer.barcode,
      barcodeType: 'EAN13',
    });
    expect(dupBarcode.status).toBe(409);
    const dupSku = await as(admin).send('post', '/api/v1/products', { ...base, sku: teer.sku });
    expect(dupSku.status).toBe(409);

    const service = await as(admin).send('post', '/api/v1/products', {
      ...base,
      type: 'service',
      trackSerial: true,
    });
    expect(service.status).toBe(422);
  });

  it('creates variants, syncs them on update and finds them by barcode', async () => {
    const attrs = await as(admin).get('/api/v1/product-attributes');
    const values = Object.fromEntries(
      attrs.body.data.flatMap((a) => a.values.map((v) => [`${a.name}:${v.value}`, v.id])),
    );
    const res = await as(admin).send('post', '/api/v1/products', {
      name: 'Easy Formal Shirt',
      sku: 'SHIRT-01',
      type: 'finished_good',
      baseUnitId: await unitId('pcs'),
      salePrice: '1200',
      hasVariants: true,
      variants: [
        { attributeValueIds: [values['Size:M'], values['Color:White']], barcode: 'SHIRT-M-W' },
        { attributeValueIds: [values['Size:L'], values['Color:White']], salePrice: '1250' },
      ],
    });
    expect(res.status).toBe(201);
    const { id, variants } = res.body.data;
    expect(variants.map((v) => v.name).sort()).toEqual(['L / White', 'M / White']);
    expect(variants.map((v) => v.sku).sort()).toEqual(['SHIRT-01-L-WHITE', 'SHIRT-01-M-WHITE']);

    const dupCombo = await as(admin).send('put', `/api/v1/products/${id}`, {
      ...res.body.data,
      variants: [
        { attributeValueIds: [values['Size:M'], values['Color:White']] },
        { attributeValueIds: [values['Color:White'], values['Size:M']] },
      ],
    });
    expect(dupCombo.status).toBe(422);

    const keep = variants.find((v) => v.name === 'M / White');
    const updated = await as(admin).send('put', `/api/v1/products/${id}`, {
      name: 'Easy Formal Shirt',
      sku: 'SHIRT-01',
      type: 'finished_good',
      baseUnitId: await unitId('pcs'),
      salePrice: '1200',
      hasVariants: true,
      variants: [
        { id: keep.id, attributeValueIds: keep.attributeValueIds, barcode: 'SHIRT-M-W' },
        { attributeValueIds: [values['Size:XL'], values['Color:Black']] },
      ],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.variants.map((v) => v.name).sort()).toEqual(['M / White', 'XL / Black']);
    expect(updated.body.data.variants.find((v) => v.name === 'M / White').id).toBe(keep.id);

    const found = await as(admin).get('/api/v1/products?search=SHIRT-M-W');
    expect(found.body.data.map((p) => p.id)).toEqual([id]);
  });

  it('filters by category including sub-categories', async () => {
    const grocery = await idOf('/api/v1/product-categories', 'code', 'GROCERY');
    const res = await as(admin).get(`/api/v1/products?categoryId=${grocery}&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThanOrEqual(12);
    const services = await as(admin).get('/api/v1/products?type=service');
    expect(services.body.data.every((p) => p.type === 'service')).toBe(true);
  });

  it('uploads, reorders and deletes images', async () => {
    const up = await as(admin)
      .upload(`/api/v1/products/${productId}/images`, 'images', PNG, 'a.png')
      .attach('images', PNG, 'b.png');
    expect(up.status).toBe(200);
    expect(up.body.data.images).toHaveLength(2);
    const [a, b] = up.body.data.images;
    expect(a.isPrimary).toBe(true);

    const ordered = await as(admin).send('put', `/api/v1/products/${productId}/images/order`, {
      imageIds: [b.id, a.id],
    });
    expect(ordered.status).toBe(200);
    expect(ordered.body.data.images[0]).toMatchObject({ id: b.id, isPrimary: true });

    expect((await as(admin).send('delete', `/api/v1/products/${productId}/images/${b.id}`)).status).toBe(200);
    const detail = await as(admin).get(`/api/v1/products/${productId}`);
    expect(detail.body.data.images).toHaveLength(1);
    expect(detail.body.data.images[0].isPrimary).toBe(true);
  });

  it('returns label data and respects delete permission', async () => {
    const labels = await as(admin).get(`/api/v1/products/labels?ids=${productId}`);
    expect(labels.status).toBe(200);
    expect(labels.body.data[0]).toMatchObject({ id: productId, salePrice: '245.5000' });

    expect((await as(storekeeper).send('delete', `/api/v1/products/${productId}`)).status).toBe(403);
    expect((await as(admin).send('delete', `/api/v1/products/${productId}`)).status).toBe(200);
    expect((await as(admin).get(`/api/v1/products/${productId}`)).status).toBe(404);
  });
});

describe('customers and suppliers', () => {
  it('creates a customer with a generated code, group and addresses', async () => {
    const group = await idOf('/api/v1/customer-groups', 'code', 'WHOLESALE');
    const res = await as(admin).send('post', '/api/v1/customers', {
      name: 'Padma Distributors',
      phone: '+8801711000999',
      groupId: group,
      creditLimit: '250000',
      paymentTermsDays: 15,
      openingBalance: '12000',
      addresses: [
        { type: 'billing', addressLine: 'Boro Bazar', city: 'Rajshahi', isDefault: true },
        { type: 'shipping', addressLine: 'Godown, Nawdapara', city: 'Rajshahi' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^CUS-\d{5}$/);
    expect(res.body.data).toMatchObject({ groupId: group, creditLimit: '250000.0000', isCustomer: true });
    expect(res.body.data.addresses).toHaveLength(2);
    expect(res.body.data.defaultAddress.city).toBe('Rajshahi');

    // a supplier group id is rejected for a customer
    const supplierGroup = await idOf('/api/v1/supplier-groups', 'code', 'LOCAL');
    const wrong = await as(admin).send('patch', `/api/v1/customers/${res.body.data.id}`, {
      groupId: supplierGroup,
    });
    expect(wrong.status).toBe(422);
  });

  it('handles dual-role parties', async () => {
    const res = await as(admin).send('post', '/api/v1/suppliers', {
      name: 'Two-Way Traders',
      alsoOtherRole: true,
    });
    expect(res.status).toBe(201);
    const { id } = res.body.data;
    expect(res.body.data).toMatchObject({ isSupplier: true, isCustomer: true });

    // visible as a customer too
    expect((await as(admin).get(`/api/v1/customers/${id}`)).status).toBe(200);
    // removing the customer role keeps the supplier
    expect((await as(admin).send('delete', `/api/v1/customers/${id}`)).status).toBe(200);
    expect((await as(admin).get(`/api/v1/customers/${id}`)).status).toBe(404);
    expect((await as(admin).get(`/api/v1/suppliers/${id}`)).status).toBe(200);
    expect((await as(admin).send('delete', `/api/v1/suppliers/${id}`)).status).toBe(200);
    expect((await as(admin).get(`/api/v1/suppliers/${id}`)).status).toBe(404);
  });

  it('scopes group codes per type and blocks deleting used groups', async () => {
    // RETAIL exists as a customer group; a supplier group may reuse the code
    const g = await as(admin).send('post', '/api/v1/supplier-groups', {
      name: 'Retail suppliers',
      code: 'RETAIL',
    });
    expect(g.status).toBe(201);
    expect(
      (await as(admin).send('post', '/api/v1/customer-groups', { name: 'R2', code: 'RETAIL' })).status,
    ).toBe(409);
    const wholesale = await idOf('/api/v1/customer-groups', 'code', 'WHOLESALE');
    expect((await as(admin).send('delete', `/api/v1/customer-groups/${wholesale}`)).status).toBe(409);
    // customer groups do not list supplier groups
    const list = await as(admin).get('/api/v1/customer-groups?limit=50');
    expect(list.body.data.some((x) => x.id === g.body.data.id)).toBe(false);
  });
});

describe('excel import / export', () => {
  const PRODUCT_HEADERS = [
    'SKU',
    'Name *',
    'Type',
    'Category code',
    'Unit *',
    'Sale price',
    'Barcode',
    'Barcode type',
  ];

  it('downloads a template', async () => {
    const res = await binary(as(admin).get('/api/v1/products/import/template'));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toContain('Instructions');
    expect(wb.worksheets[0].getRow(1).getCell(1).value).toBe('SKU');
  });

  it('validates rows, reports errors and commits with upsert', async () => {
    const file = await xlsx(PRODUCT_HEADERS, [
      ['IMP-001', 'Imported Lentil 1 kg', 'finished_good', 'PULSES', 'pcs', '130', '', ''],
      ['IMP-002', 'Imported Chili Powder', 'finished_good', 'NOPE', 'pcs', 'abc', '', ''],
      ['IMP-001', 'Duplicate row', 'finished_good', '', 'pcs', '1', '', ''],
      ['P-000001', 'ACI Pure Miniket Rice 5 kg (updated)', 'finished_good', 'RICE', 'pcs', '415', '', ''],
    ]);

    const check = await as(admin).upload('/api/v1/products/import?mode=validate', 'file', file, 'p.xlsx');
    expect(check.status).toBe(200);
    expect(check.body.data).toMatchObject({ total: 4, valid: 2, invalid: 2, toCreate: 1, toUpdate: 1 });
    expect(check.body.data.errors.map((e) => e.row)).toEqual([3, 4]);

    const report = await binary(
      api()
        .post('/api/v1/products/import?mode=report')
        .set(bearer(admin.token))
        .attach('file', file, 'p.xlsx'),
    );
    expect(report.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(report.body);
    const sheet = wb.worksheets[0];
    expect(sheet.getRow(1).getCell(PRODUCT_HEADERS.length + 1).value).toBe('Errors');
    expect(String(sheet.getRow(3).getCell(PRODUCT_HEADERS.length + 1).value)).toMatch(/category/i);

    const blocked = await as(admin).upload('/api/v1/products/import?mode=commit', 'file', file, 'p.xlsx');
    expect(blocked.status).toBe(422);

    const commit = await as(admin).upload(
      '/api/v1/products/import?mode=commit&skipInvalid=true',
      'file',
      file,
      'p.xlsx',
    );
    expect(commit.status).toBe(200);
    expect(commit.body.data).toMatchObject({ created: 1, updated: 1, skipped: 2 });

    const rice = await as(admin).get('/api/v1/products?search=P-000001');
    expect(rice.body.data[0]).toMatchObject({
      name: 'ACI Pure Miniket Rice 5 kg (updated)',
      salePrice: '415.0000',
    });
    // packs survive an import update
    const detail = await as(admin).get(`/api/v1/products/${rice.body.data[0].id}`);
    expect(detail.body.data.units).toHaveLength(1);
  });

  it('round-trips an export and imports categories parents-first', async () => {
    const exported = await binary(as(admin).get('/api/v1/brands/export'));
    expect(exported.status).toBe(200);
    const reimport = await as(admin).upload(
      '/api/v1/brands/import?mode=validate',
      'file',
      exported.body,
      'b.xlsx',
    );
    expect(reimport.status).toBe(200);
    expect(reimport.body.data.invalid).toBe(0);
    expect(reimport.body.data.toCreate).toBe(0);

    const cats = await xlsx(
      ['Code', 'Name', 'Parent code'],
      [
        ['DAIRY-MILK', 'Milk', 'DAIRY'],
        ['DAIRY', 'Dairy', ''],
      ],
    );
    const res = await as(admin).upload(
      '/api/v1/product-categories/import?mode=commit',
      'file',
      cats,
      'c.xlsx',
    );
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(2);
    const tree = await as(admin).get('/api/v1/product-categories/tree');
    expect(tree.body.data.find((c) => c.code === 'DAIRY').children[0].code).toBe('DAIRY-MILK');
  });

  it('imports customers with generated codes and rejects bad files', async () => {
    const file = await xlsx(
      ['Code', 'Name', 'Phone', 'Group code', 'Address', 'City'],
      [
        ['', 'Imported Shop One', '+8801700000001', 'RETAIL', 'Main Road', 'Bogura'],
        ['', 'Imported Shop Two', '', 'NOPE', '', ''],
      ],
    );
    const res = await as(admin).upload(
      '/api/v1/customers/import?mode=commit&skipInvalid=true',
      'file',
      file,
      'c.xlsx',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: 1, skipped: 1 });
    const found = await as(admin).get('/api/v1/customers?search=Imported Shop One');
    expect(found.body.data[0].code).toMatch(/^CUS-\d{5}$/);
    expect(found.body.data[0].defaultAddress?.city ?? found.body.data[0].addresses?.[0]?.city).toBe('Bogura');

    const junk = await as(admin).upload(
      '/api/v1/customers/import',
      'file',
      Buffer.from('not excel'),
      'x.xlsx',
    );
    expect(junk.status).toBe(400);
    expect((await as(cashier).get('/api/v1/suppliers/export')).status).toBe(403);
  });
});
