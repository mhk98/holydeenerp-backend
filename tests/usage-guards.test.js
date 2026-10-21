import { closeDatabase } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

/** Master data that documents use cannot be deleted (it can be deactivated instead). */

let admin;
let pcs;
const S = '/api/v1/settings';

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});

let seq = 0;
const tag = () => `${Date.now() % 1_000_000}${(seq += 1)}`;

async function ok(res, what) {
  if (![200, 201].includes(res.status)) throw new Error(`${what} failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const newProduct = (fields = {}) =>
  as(admin)
    .send('post', '/api/v1/products', {
      name: `Guard test item ${tag()}`,
      type: 'finished_good',
      baseUnitId: pcs,
      salePrice: '100',
      ...fields,
    })
    .then((r) => ok(r, 'product'));

const newCustomer = () =>
  as(admin)
    .send('post', '/api/v1/customers', { name: `Guard test customer ${tag()}` })
    .then((r) => ok(r, 'customer'));

/** A draft quotation is enough to "use" a customer, product, variant, unit and tax group. */
const quote = (customerId, line) =>
  as(admin)
    .send('post', '/api/v1/sales/quotations', {
      customerId,
      items: [{ quantity: '1', unitPrice: '100', ...line }],
    })
    .then((r) => ok(r, 'quotation'));

beforeAll(async () => {
  admin = await login('admin@holydeen.com');
  pcs = (await as(admin).get('/api/v1/products/lookups')).body.data.units.find((u) => u.code === 'pcs').id;
}, 120_000);

afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('customers and suppliers', () => {
  it('refuses to delete a customer with documents, but lets it be deactivated', async () => {
    const customer = await newCustomer();
    const p = await newProduct();
    await quote(customer.id, { productId: p.id });
    const del = await as(admin).send('delete', `/api/v1/customers/${customer.id}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/used by 1 document/);
    expect(
      (await as(admin).send('patch', `/api/v1/customers/${customer.id}`, { isActive: false })).body.data
        .isActive,
    ).toBe(false);

    const unused = await newCustomer();
    expect((await as(admin).send('delete', `/api/v1/customers/${unused.id}`)).status).toBe(200);
  }, 120_000);

  it('refuses to delete a party with an opening balance', async () => {
    const c = await ok(
      await as(admin).send('post', '/api/v1/customers', {
        name: `Guard opening ${tag()}`,
        openingBalance: '500',
        openingBalanceType: 'debit',
      }),
      'customer',
    );
    const del = await as(admin).send('delete', `/api/v1/customers/${c.id}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/opening balance/);
  }, 120_000);
});

describe('settings master data', () => {
  it('keeps units, tax groups and payment methods that are in use', async () => {
    const unit = await ok(
      await as(admin).send('post', `${S}/units`, {
        name: `Crate ${tag()}`,
        code: `CR${tag()}`,
        category: 'count',
      }),
      'unit',
    );
    const group = await ok(
      await as(admin).send('post', `${S}/tax-groups`, {
        name: `Zero ${tag()}`,
        code: `Z${tag()}`,
        rates: [],
      }),
      'tax group',
    );
    const method = await ok(
      await as(admin).send('post', `${S}/payment-methods`, {
        name: `Voucher ${tag()}`,
        code: `V${tag()}`,
        type: 'other',
        // Last in display order, so it doesn't change what other tests see first.
        sortOrder: 9999,
      }),
      'method',
    );
    await newProduct({ baseUnitId: unit.id, taxGroupId: group.id });
    const customer = await newCustomer();
    await ok(
      await as(admin).send('post', '/api/v1/sales/receipts', {
        customerId: customer.id,
        paymentMethodId: method.id,
        amount: '50',
        allocations: [],
      }),
      'receipt',
    );

    for (const url of [
      `${S}/units/${unit.id}`,
      `${S}/tax-groups/${group.id}`,
      `${S}/payment-methods/${method.id}`,
    ]) {
      const res = await as(admin).send('delete', url);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/is used by/);
    }

    const spare = await ok(
      await as(admin).send('post', `${S}/units`, {
        name: `Spare ${tag()}`,
        code: `SP${tag()}`,
        category: 'count',
      }),
      'unit',
    );
    expect((await as(admin).send('delete', `${S}/units/${spare.id}`)).status).toBe(200);
  }, 180_000);
});

describe('products and variants', () => {
  it('refuses to delete a product that is on a document, and to drop a variant in use', async () => {
    const attrs = (await as(admin).get('/api/v1/product-attributes')).body.data;
    const values = Object.fromEntries(
      attrs.flatMap((a) => a.values.map((v) => [`${a.name}:${v.value}`, v.id])),
    );
    const sku = `GRD-${tag()}`;
    const base = {
      name: `Guard shirt ${tag()}`,
      sku,
      type: 'finished_good',
      baseUnitId: pcs,
      salePrice: '900',
      hasVariants: true,
    };
    const product = await ok(
      await as(admin).send('post', '/api/v1/products', {
        ...base,
        variants: [
          { attributeValueIds: [values['Size:M'], values['Color:White']] },
          { attributeValueIds: [values['Size:L'], values['Color:White']] },
        ],
      }),
      'product',
    );
    const used = product.variants.find((v) => v.name === 'M / White');
    const unused = product.variants.find((v) => v.name === 'L / White');
    await quote((await newCustomer()).id, { productId: product.id, variantId: used.id });

    // Dropping the variant on the quotation is refused; dropping the unused one works.
    const dropUsed = await as(admin).send('put', `/api/v1/products/${product.id}`, {
      ...base,
      variants: [{ id: unused.id, attributeValueIds: unused.attributeValueIds }],
    });
    expect(dropUsed.status).toBe(409);
    expect(dropUsed.body.message).toMatch(/Variant M \/ White/);
    const dropUnused = await as(admin).send('put', `/api/v1/products/${product.id}`, {
      ...base,
      variants: [{ id: used.id, attributeValueIds: used.attributeValueIds }],
    });
    expect(dropUnused.status).toBe(200);
    expect(dropUnused.body.data.variants.map((v) => v.name)).toEqual(['M / White']);

    const del = await as(admin).send('delete', `/api/v1/products/${product.id}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/mark it inactive/);
  }, 180_000);
});
