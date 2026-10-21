import { randomUUID } from 'node:crypto';
import { closeDatabase } from '../src/config/db.js';
import { CustomerReceipt, SalesInvoice, StockBalance } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

let admin;
let cashier;
let storekeeper;
let pcs;
let register;
let session;
const method = {};
const P = '/api/v1/pos';

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});

async function newProduct(fields = {}) {
  const res = await as(admin).send('post', '/api/v1/products', {
    name: `POS test item ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: 'finished_good',
    baseUnitId: pcs,
    purchasePrice: '150',
    salePrice: '250',
    ...fields,
  });
  if (res.status !== 201) throw new Error(`product create failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function stockIn(productId, quantity, unitCost = '150') {
  const created = await as(admin).send('post', '/api/v1/inventory/adjustments', {
    kind: 'adjustment',
    warehouseId: register.warehouseId,
    items: [{ productId, direction: 'in', quantity, unitCost }],
  });
  const posted = await as(admin).send('post', `/api/v1/inventory/adjustments/${created.body.data.id}/submit`);
  if (posted.body.data?.status !== 'posted')
    throw new Error(`stock in failed: ${JSON.stringify(posted.body)}`);
}

const balanceOf = async (productId) =>
  (await StockBalance.findOne({ where: { warehouseId: register.warehouseId, productId, variantId: null } }))
    ?.quantity;

const sale = (items, payments, extra = {}) => ({
  clientUuid: randomUUID(),
  registerId: register.id,
  sessionId: session.id,
  items,
  payments,
  ...extra,
});
const line = (p, quantity, extra = {}) => ({ productId: p.id, quantity, unitPrice: '250', ...extra });

beforeAll(async () => {
  [admin, cashier, storekeeper] = await Promise.all([
    login('admin@holydeen.com'),
    login('cashier@holydeen.com'),
    login('storekeeper@holydeen.com'),
  ]);
  pcs = (await as(admin).get('/api/v1/products/lookups')).body.data.units.find((u) => u.code === 'pcs').id;
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', { requireApproval: false });
  await as(admin).send('put', '/api/v1/settings/preferences/pos', {
    maxDiscountPercent: 10,
    allowPriceEdit: false,
  });
  const boot = (await as(cashier).get(`${P}/bootstrap`)).body.data;
  register = boot.registers.find((r) => r.code === 'AGR-01');
  for (const m of boot.paymentMethods) method[m.code] = m.id;
}, 180_000);

afterAll(async () => {
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', { requireApproval: true });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('access & start-up', () => {
  it('needs POS permissions and shows only the branch registers', async () => {
    expect((await as(storekeeper).get(`${P}/bootstrap`)).status).toBe(403);
    const boot = (await as(cashier).get(`${P}/bootstrap`, { registerId: register.id })).body.data;
    // The cashier works in Chattogram only.
    expect(boot.registers.map((r) => r.code)).toEqual(['AGR-01']);
    expect(boot.settings.pos).toMatchObject({ maxDiscountPercent: 10 });
    expect(boot.taxGroups.length).toBeGreaterThan(0);
    expect(register.defaultCustomer?.name).toBe('Walk-in Customer');
  });
});

describe('a cashier shift', () => {
  let product;
  let firstSale;

  it('opens the register once', async () => {
    const opened = await as(cashier).send('post', `${P}/sessions`, {
      registerId: register.id,
      openingCash: '1000',
    });
    expect(opened.status).toBe(201);
    session = opened.body.data;
    expect(session).toMatchObject({ status: 'open', openingCash: '1000.0000' });
    expect(session.number).toMatch(/^AGR-01-Z\d{5}$/);
    const again = await as(cashier).send('post', `${P}/sessions`, {
      registerId: register.id,
      openingCash: '0',
    });
    expect(again.status).toBe(409);
    const catalog = (await as(cashier).get(`${P}/catalog`, { registerId: register.id })).body.data;
    expect(catalog.items.length).toBeGreaterThan(0);
  }, 120_000);

  it('sells with a split payment and gives change from cash', async () => {
    product = await newProduct();
    await stockIn(product.id, '10');
    const body = sale(
      [line(product, '3')],
      [
        { paymentMethodId: method.CARD, amount: '200', reference: 'APP-7781' },
        { paymentMethodId: method.CASH, amount: '1000' },
      ],
    );
    const res = await as(cashier).send('post', `${P}/sales`, body);
    expect(res.status).toBe(201);
    firstSale = res.body.data;
    expect(firstSale.invoice).toMatchObject({
      channel: 'pos',
      status: 'paid',
      total: '750.0000',
      tendered: '1200.0000',
      changeAmount: '450.0000',
    });
    expect(firstSale.invoice.number).toMatch(/^POS-CTG-/);
    expect(firstSale.payments.map((p) => [p.method, p.amount])).toEqual([
      ['Card (Visa / Mastercard)', '200.0000'],
      ['Cash', '550.0000'],
    ]);
    expect(await balanceOf(product.id)).toBe('7.0000');

    // The same sale sent again (e.g. a retry) is not created twice.
    const again = await as(cashier).send('post', `${P}/sales`, body);
    expect(again.body.data.invoice.number).toBe(firstSale.invoice.number);
    expect(await SalesInvoice.count({ where: { clientUuid: body.clientUuid } })).toBe(1);
  }, 180_000);

  it('enforces walk-in full payment, card limits and the cashier discount limit', async () => {
    const short = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale([line(product, '1')], [{ paymentMethodId: method.CASH, amount: '100' }]),
    );
    expect(short.status).toBe(422);
    expect(short.body.message).toMatch(/paid in full/);

    const overCard = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale([line(product, '1')], [{ paymentMethodId: method.CARD, amount: '300', reference: 'X1' }]),
    );
    expect(overCard.status).toBe(422);

    const bigDiscount = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale(
        [line(product, '1', { discountType: 'percent', discountValue: '50' })],
        [{ paymentMethodId: method.CASH, amount: '125' }],
      ),
    );
    expect(bigDiscount.status).toBe(422);
    expect(bigDiscount.body.errors[0].field).toBe('items.0.discountValue');

    const priceChange = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale([line(product, '1', { unitPrice: '200' })], [{ paymentMethodId: method.CASH, amount: '200' }]),
    );
    expect(priceChange.status).toBe(422);
  }, 180_000);

  it('holds and recalls a cart', async () => {
    const heldRes = await as(cashier).send('post', `${P}/held`, {
      registerId: register.id,
      label: 'Table 4',
      cart: { lines: [{ productId: product.id, quantity: '2' }] },
      total: '500',
    });
    expect(heldRes.status).toBe(201);
    const list = (await as(cashier).get(`${P}/held`, { registerId: register.id })).body.data;
    expect(list.some((h) => h.label === 'Table 4')).toBe(true);
    const recalled = await as(cashier).send('post', `${P}/held/${heldRes.body.data.id}/recall`);
    expect(recalled.body.data.cart.lines[0].quantity).toBe('2');
    expect((await as(cashier).send('post', `${P}/held/${heldRes.body.data.id}/recall`)).status).toBe(404);
  }, 60_000);

  let returnCredit;
  it('returns with a cash refund, and exchanges with store credit', async () => {
    const found = (await as(cashier).get(`${P}/sales/lookup`, { number: firstSale.invoice.number })).body
      .data;
    const item = found.returnable[0];
    expect(item).toMatchObject({ returnableBaseQuantity: '3.0000', unitRefund: '250.0000' });

    const refund = await as(cashier).send('post', `${P}/sales/${found.invoice.id}/return`, {
      registerId: register.id,
      sessionId: session.id,
      reason: 'Damaged box',
      items: [{ invoiceItemId: item.invoiceItemId, quantity: '1' }],
      refund: { paymentMethodId: method.CASH },
    });
    expect(refund.status).toBe(201);
    expect(refund.body.data).toMatchObject({
      total: '250.0000',
      refundedAmount: '250.0000',
      credit: '0.0000',
    });
    expect(await balanceOf(product.id)).toBe('8.0000');

    // Exchange: return one more without a refund, then spend the credit on a new sale.
    const exchange = await as(cashier).send('post', `${P}/sales/${found.invoice.id}/return`, {
      registerId: register.id,
      sessionId: session.id,
      items: [{ invoiceItemId: item.invoiceItemId, quantity: '1' }],
    });
    returnCredit = exchange.body.data;
    expect(returnCredit.credit).toBe('250.0000');
    const swap = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale([line(product, '2')], [{ paymentMethodId: method.CASH, amount: '250' }], {
        credits: [{ returnId: returnCredit.id, amount: '250' }],
      }),
    );
    expect(swap.status).toBe(201);
    expect(swap.body.data.invoice).toMatchObject({
      status: 'paid',
      total: '500.0000',
      changeAmount: '0.0000',
    });
    expect(await balanceOf(product.id)).toBe('7.0000');

    // Only one item is left to return on the first sale.
    const after = (await as(cashier).get(`${P}/sales/lookup`, { number: firstSale.invoice.number })).body
      .data;
    expect(after.returnable[0].returnableBaseQuantity).toBe('1.0000');
  }, 240_000);

  it('syncs offline sales once, even past the stock', async () => {
    const offline = sale([line(product, '9')], [{ paymentMethodId: method.CASH, amount: '2250' }], {
      offline: { number: 'OFF-AGR-01-0001', soldAt: new Date().toISOString() },
    });
    const first = await as(cashier).send('post', `${P}/sales/sync`, { sales: [offline] });
    expect(first.body.data).toMatchObject({ synced: 1, failed: 0 });
    expect(first.body.data.results[0].invoice.stockWarning).toBe(true);
    expect(await balanceOf(product.id)).toBe('-2.0000');
    const second = await as(cashier).send('post', `${P}/sales/sync`, { sales: [offline] });
    expect(second.body.data.results[0]).toMatchObject({ ok: true, duplicate: true });
    // Found by the number printed offline.
    const found = await as(cashier).get(`${P}/sales/lookup`, { number: 'OFF-AGR-01-0001' });
    expect(found.body.data.invoice.id).toBe(first.body.data.results[0].invoice.id);
  }, 180_000);

  it('balances the drawer: cash in/out, X report and a counted close (Z report)', async () => {
    await as(cashier).send('post', `${P}/sessions/${session.id}/cash`, {
      type: 'in',
      amount: '500',
      reason: 'Change float',
    });
    await as(cashier).send('post', `${P}/sessions/${session.id}/cash`, {
      type: 'out',
      amount: '200',
      reason: 'Tea & snacks',
    });
    const tooMuch = await as(cashier).send('post', `${P}/sessions/${session.id}/cash`, {
      type: 'out',
      amount: '999999',
      reason: 'Oops',
    });
    expect(tooMuch.status).toBe(422);

    const x = (await as(cashier).get(`${P}/sessions/${session.id}`)).body.data.report;
    // 1000 opening + cash 550 + 250 + 2250 − refund 250 + 500 − 200
    expect(x.cash).toMatchObject({
      opening: '1000.0000',
      received: '3050.0000',
      refunded: '250.0000',
      cashIn: '500.0000',
      cashOut: '200.0000',
      expected: '4100.0000',
    });
    expect(x.sales.count).toBe(3);
    expect(x.returns).toMatchObject({ count: 2, total: '500.0000' });
    expect(await CustomerReceipt.count({ where: { posSessionId: session.id } })).toBe(4);

    // 4 × 1000 + 1 × 50 + 2 × 20 = 4090 counted → 10 short.
    const closed = await as(cashier).send('post', `${P}/sessions/${session.id}/close`, {
      denominations: { 1000: 4, 50: 1, 20: 2 },
      notes: 'End of day',
    });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: 'closed',
      expectedCash: '4100.0000',
      countedCash: '4090.0000',
      variance: '-10.0000',
    });
    expect(closed.body.data.report.cash.variance).toBe('-10.0000');

    const late = await as(cashier).send(
      'post',
      `${P}/sales`,
      sale([line(product, '1')], [{ paymentMethodId: method.CASH, amount: '250' }]),
    );
    expect(late.status).toBe(422);
    expect(
      (await as(cashier).get(`${P}/sessions/current`, { registerId: register.id })).body.data,
    ).toBeNull();
  }, 180_000);
});
