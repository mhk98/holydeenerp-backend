import { closeDatabase } from '../src/config/db.js';
import { CreditOverride, PaymentReminder, StockBalance } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { runAutomaticReminders } from '../src/modules/sales/reminders.service.js';
import { nextDate } from '../src/modules/sales/recurring.service.js';
import { amountInWords } from '../src/utils/amount-words.js';
import { api, bearer, login } from './helpers.js';

let admin;
let manager;
let cashier;
let pcs;
let vat15;
const wh = {};
const S = '/api/v1/sales';

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});

let seq = 0;
async function newProduct(fields = {}) {
  seq += 1;
  const res = await as(admin).send('post', '/api/v1/products', {
    name: `Sales test item ${Date.now()}-${seq}`,
    type: 'finished_good',
    baseUnitId: pcs,
    purchasePrice: '60',
    salePrice: '100',
    ...fields,
  });
  if (res.status !== 201) throw new Error(`product create failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function newCustomer(fields = {}) {
  seq += 1;
  const res = await as(admin).send('post', '/api/v1/customers', {
    name: `Sales test customer ${Date.now()}-${seq}`,
    email: `customer.${Date.now()}.${seq}@test.holydeen.com`,
    paymentTermsDays: 30,
    ...fields,
  });
  if (res.status !== 201) throw new Error(`customer create failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

/** Put stock in with an opening-style adjustment (approval off). */
async function stockIn(productId, quantity, unitCost, warehouseId = wh['WH-TEJ']) {
  const created = await as(admin).send('post', '/api/v1/inventory/adjustments', {
    kind: 'adjustment',
    warehouseId,
    items: [{ productId, direction: 'in', quantity, unitCost }],
  });
  const posted = await as(admin).send('post', `/api/v1/inventory/adjustments/${created.body.data.id}/submit`);
  if (posted.body.data?.status !== 'posted')
    throw new Error(`stock in failed: ${JSON.stringify(posted.body)}`);
}

const balanceOf = async (productId, warehouseId = wh['WH-TEJ']) =>
  (await StockBalance.findOne({ where: { warehouseId, productId, variantId: null } }))?.quantity;

beforeAll(async () => {
  [admin, manager, cashier] = await Promise.all([
    login('admin@holydeen.com'),
    login('manager@holydeen.com'),
    login('cashier@holydeen.com'),
  ]);
  const lookups = await as(admin).get('/api/v1/products/lookups');
  pcs = lookups.body.data.units.find((u) => u.code === 'pcs').id;
  vat15 = (await as(admin).get('/api/v1/purchase/lookups')).body.data.taxGroups.find(
    (g) => g.rate === '15.00',
  );
  for (const w of (await as(admin).get('/api/v1/inventory/warehouses')).body.data) wh[w.code] = w.id;
  const inv = await as(admin).send('put', '/api/v1/settings/preferences/inventory', {
    requireApproval: false,
  });
  const sales = await as(admin).send('put', '/api/v1/settings/preferences/sales', {
    roundTo: '1',
    roundingMode: 'nearest',
    creditCheck: true,
  });
  if (inv.status !== 200 || sales.status !== 200) throw new Error('settings failed');
}, 180_000);

afterAll(async () => {
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', { requireApproval: true });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('amount in words', () => {
  it('spells taka in English and Bangla (lakh / crore)', () => {
    expect(amountInWords('15663.50', 'en')).toBe(
      'Taka Fifteen Thousand Six Hundred Sixty-Three and Fifty Paisa Only',
    );
    expect(amountInWords('15663.50', 'bn')).toBe('পনেরো হাজার ছয়শত তেষট্টি টাকা পঞ্চাশ পয়সা মাত্র');
    expect(amountInWords('1234567', 'en')).toBe(
      'Taka Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven Only',
    );
    expect(amountInWords('250000000', 'bn')).toBe('পঁচিশ কোটি টাকা মাত্র');
  });
});

describe('recurring dates', () => {
  it('handles month ends', () => {
    expect(nextDate('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextDate('2026-11-30', 'quarterly')).toBe('2027-02-28');
    expect(nextDate('2026-10-19', 'weekly', 2)).toBe('2026-11-02');
  });
});

describe('access', () => {
  it('needs sales permissions', async () => {
    expect((await as(cashier).get(`${S}/orders`)).status).toBe(200);
    // Cancelling a posted invoice needs sales.approve, which cashiers don't have.
    expect((await as(cashier).send('post', `${S}/invoices/1/cancel`, {})).status).toBe(403);
    // Form lookups and the inventory item / warehouse pickers work without settings or inventory rights.
    const lookups = await as(cashier).get(`${S}/lookups`);
    expect(lookups.status).toBe(200);
    expect(lookups.body.data).toMatchObject({ settings: { roundTo: expect.any(String) } });
    expect(Array.isArray(lookups.body.data.taxGroups)).toBe(true);
    expect((await as(cashier).get('/api/v1/inventory/warehouses')).status).toBe(200);
    expect((await as(cashier).get('/api/v1/inventory/items/search', { q: 'a' })).status).toBe(200);
  });
});

describe('pricing', () => {
  it('applies line and document discounts, tax and rounding', async () => {
    const res = await as(admin).send('post', `${S}/calculate`, {
      discountType: 'amount',
      discountValue: '50',
      items: [
        {
          quantity: '3',
          unitPrice: '333.33',
          discountType: 'percent',
          discountValue: '10',
          taxGroupId: vat15?.id ?? null,
        },
        { quantity: '1', unitPrice: '100', discountType: 'amount', discountValue: '20' },
      ],
    });
    expect(res.status).toBe(200);
    const { totals, lines } = res.body.data;
    // gross 999.99 + 100; line discounts 100.00 + 20; document discount 50 spread by value.
    expect(totals).toMatchObject({ subtotal: '1099.9900', discountTotal: '170.0000' });
    expect(lines[0].discountAmount).toBe('100.0000');
    expect(Number(lines[0].documentDiscount) + Number(lines[1].documentDiscount)).toBe(50);
    // Total rounds to whole taka and the difference is shown as round-off.
    expect(Number(totals.total) % 1).toBe(0);
    const sum = lines.reduce((s, l) => s + Number(l.lineTotal), 0);
    expect(Number((sum + Number(totals.roundOff)).toFixed(4))).toBe(Number(totals.total));
  });

  it('uses the price list of the customer group', async () => {
    const p = await newProduct();
    const group = await as(admin).send('post', '/api/v1/customer-groups', {
      name: `Wholesale ${Date.now()}`,
      code: `WS${Date.now() % 100000}`,
    });
    expect(group.status).toBe(201);
    const list = await as(admin).send('post', `${S}/price-lists`, {
      name: 'Wholesale prices',
      code: `PL${Date.now() % 100000}`,
      customerGroupId: group.body.data.id,
      items: [{ productId: p.id, price: '85' }],
    });
    expect(list.status).toBe(201);
    const member = await newCustomer({ groupId: group.body.data.id });
    const other = await newCustomer();
    const prices = async (customerId) =>
      (await as(admin).send('post', `${S}/prices`, { customerId, items: [{ productId: p.id }] })).body
        .data[0];
    expect(await prices(member.id)).toMatchObject({ unitPrice: '85.0000', source: { type: 'price_list' } });
    expect(await prices(other.id)).toMatchObject({ unitPrice: '100.0000', source: { type: 'standard' } });
  }, 180_000);
});

describe('order to cash', () => {
  it('quotation → order (credit check) → partial challan → invoice → receipt → return → ledger & aging', async () => {
    const p = await newProduct();
    await stockIn(p.id, '20', '60');
    const customer = await newCustomer({ creditLimit: '500' });

    // Quotation at the standard price, converted into an order.
    const quote = await as(admin).send('post', `${S}/quotations`, {
      customerId: customer.id,
      items: [{ productId: p.id, quantity: '10' }],
    });
    expect(quote.status).toBe(201);
    expect(quote.body.data).toMatchObject({ total: '1000.0000' });
    const order = await as(admin).send('post', `${S}/quotations/${quote.body.data.id}/convert-to-order`, {
      warehouseId: wh['WH-TEJ'],
    });
    expect(order.status).toBe(201);
    const orderId = order.body.data.id;
    expect((await as(admin).get(`${S}/quotations/${quote.body.data.id}`)).body.data.status).toBe('converted');

    // 1000 is above the 500 credit limit: refused, then overridden with a reason by a manager.
    const blocked = await as(admin).send('post', `${S}/orders/${orderId}/confirm`, {});
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toMatch(/credit limit/);
    const confirmed = await as(manager).send('post', `${S}/orders/${orderId}/confirm`, {
      creditOverride: { reason: 'Long-standing customer' },
    });
    expect(confirmed.body.data.status).toBe('confirmed');
    expect(await CreditOverride.count({ where: { documentType: 'sales_order', documentId: orderId } })).toBe(
      1,
    );

    // Deliver 6 of 10 on a challan.
    const challan = await as(admin).send('post', `${S}/orders/${orderId}/convert-to-challan`);
    expect(challan.status).toBe(201);
    const line = challan.body.data.items[0];
    await as(admin).send('put', `${S}/challans/${challan.body.data.id}`, {
      customerId: customer.id,
      warehouseId: wh['WH-TEJ'],
      orderId,
      vehicleNo: 'DHA-11-2233',
      items: [{ orderItemId: line.orderItemId, productId: p.id, quantity: '6' }],
    });
    const posted = await as(admin).send('post', `${S}/challans/${challan.body.data.id}/post`);
    expect(posted.body.data).toMatchObject({ status: 'posted', costTotal: '360.0000' });
    expect(await balanceOf(p.id)).toBe('14.0000');
    const partly = (await as(admin).get(`${S}/orders/${orderId}`)).body.data;
    expect(partly).toMatchObject({ status: 'partially_delivered', deliveredPercent: '60.0' });

    // Invoice the order: 6 from the challan (no stock) + 4 delivered directly by the invoice.
    const invoice = await as(admin).send('post', `${S}/orders/${orderId}/convert-to-invoice`);
    expect(invoice.status).toBe(201);
    const inv = invoice.body.data;
    expect(inv.items.map((i) => [i.quantity, Boolean(i.challanItemId)])).toEqual([
      ['6.0000', true],
      ['4.0000', false],
    ]);
    expect((await as(admin).send('post', `${S}/invoices/${inv.id}/post`, {})).status).toBe(422);
    const postedInv = await as(manager).send('post', `${S}/invoices/${inv.id}/post`, {
      creditOverride: { reason: 'Approved by MD' },
    });
    expect(postedInv.body.data).toMatchObject({
      status: 'unpaid',
      total: '1000.0000',
      costTotal: '600.0000',
    });
    expect(await balanceOf(p.id)).toBe('10.0000');
    expect((await as(admin).get(`${S}/orders/${orderId}`)).body.data.status).toBe('invoiced');

    // Print data: words in both languages and a QR code.
    const print = await as(admin).get(`${S}/invoices/${inv.id}/print`);
    expect(print.body.data.amountInWords).toEqual({
      en: 'Taka One Thousand Only',
      bn: 'এক হাজার টাকা মাত্র',
    });
    expect(print.body.data.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(print.body.data.qrText).toContain(`INV:${inv.number}`);

    // Receive 400.
    const methods = (await as(admin).get('/api/v1/purchase/lookups')).body.data.paymentMethods;
    const cash = methods.find((m) => !m.requiresReference);
    const receipt = await as(admin).send('post', `${S}/receipts`, {
      customerId: customer.id,
      paymentMethodId: cash.id,
      amount: '400',
      allocations: [{ invoiceId: inv.id, amount: '400' }],
    });
    expect(receipt.status).toBe(201);
    expect((await as(admin).get(`${S}/invoices/${inv.id}`)).body.data).toMatchObject({
      status: 'partially_paid',
      balance: '600.0000',
    });

    // Return 2 units: back into stock at cost, credit applied to the invoice.
    const ret = await as(admin).send('post', `${S}/invoices/${inv.id}/convert-to-return`, { type: 'return' });
    expect(ret.status).toBe(201);
    const first = ret.body.data.items[0];
    await as(admin).send('put', `${S}/returns/${ret.body.data.id}`, {
      type: 'return',
      customerId: customer.id,
      invoiceId: inv.id,
      warehouseId: wh['WH-TEJ'],
      reason: 'Damaged packaging',
      items: [
        {
          invoiceItemId: first.invoiceItemId,
          productId: p.id,
          quantity: '2',
          unitPrice: first.unitPrice,
          taxGroupId: first.taxGroupId,
          priceIncludesTax: first.priceIncludesTax,
        },
      ],
    });
    const postedRet = await as(admin).send('post', `${S}/returns/${ret.body.data.id}/post`);
    expect(postedRet.body.data).toMatchObject({
      status: 'posted',
      total: '200.0000',
      appliedAmount: '200.0000',
    });
    expect(await balanceOf(p.id)).toBe('12.0000');
    expect((await as(admin).get(`${S}/invoices/${inv.id}`)).body.data.balance).toBe('400.0000');

    // Ledger and aging.
    const ledger = await as(admin).get(`${S}/customers/${customer.id}/ledger`);
    expect(ledger.body.data.entries.map((e) => [e.type, e.debit, e.credit])).toEqual([
      ['invoice', '1000.0000', '0.0000'],
      ['receipt', '0.0000', '400.0000'],
      ['return', '0.0000', '200.0000'],
    ]);
    expect(ledger.body.data.closing).toBe('400.0000');
    const aging = await as(admin).get(`${S}/receivables/aging`, { customerId: customer.id });
    expect(aging.body.data.rows[0]).toMatchObject({ current: '400.0000', total: '400.0000' });
  }, 600_000);
});

describe('direct invoice, reminders and recurring', () => {
  it('sells from stock, reminds the customer and repeats monthly', async () => {
    const p = await newProduct();
    await stockIn(p.id, '5', '50');
    const customer = await newCustomer({ paymentTermsDays: 0 });
    const created = await as(admin).send('post', `${S}/invoices`, {
      customerId: customer.id,
      warehouseId: wh['WH-TEJ'],
      items: [{ productId: p.id, quantity: '2' }],
    });
    expect(created.status).toBe(201);
    const posted = await as(admin).send('post', `${S}/invoices/${created.body.data.id}/post`, {});
    expect(posted.body.data.status).toBe('unpaid');
    expect(await balanceOf(p.id)).toBe('3.0000');
    // Stock-delivering invoices are corrected with returns, not cancelled.
    expect((await as(admin).send('post', `${S}/invoices/${created.body.data.id}/cancel`)).status).toBe(409);

    const reminded = await as(admin).send('post', `${S}/invoices/${created.body.data.id}/remind`, {});
    expect(reminded.status).toBe(200);
    expect(reminded.body.data.reminders[0]).toMatchObject({ kind: 'manual', status: 'sent' });

    // Automatic reminder the day after the due date — once only.
    await as(admin).send('put', '/api/v1/settings/preferences/sales', {
      remindersEnabled: true,
      reminderDaysAfter: [1],
      reminderDaysBefore: [],
    });
    try {
      const due = posted.body.data.dueDate;
      const tomorrow = new Date(`${due}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const day = tomorrow.toISOString().slice(0, 10);
      expect(await runAutomaticReminders(day)).toBeGreaterThanOrEqual(1);
      expect(await runAutomaticReminders(day)).toBe(0);
      expect(
        await PaymentReminder.count({
          where: { invoiceId: created.body.data.id, kind: 'after_due', status: 'sent' },
        }),
      ).toBe(1);
    } finally {
      await as(admin).send('put', '/api/v1/settings/preferences/sales', { remindersEnabled: false });
    }

    // Repeat monthly; running now creates the next invoice (a draft) and moves the date on.
    const schedule = await as(admin).send('post', `${S}/invoices/${created.body.data.id}/make-recurring`, {
      frequency: 'monthly',
    });
    expect(schedule.status).toBe(201);
    const before = schedule.body.data.nextRunDate;
    const run = await as(admin).send('post', `${S}/recurring/${schedule.body.data.id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.data.invoiceId).toBeTruthy();
    expect(run.body.data.schedule).toMatchObject({ runsCount: 1, nextRunDate: nextDate(before, 'monthly') });
    const next = await as(admin).get(`${S}/invoices/${run.body.data.invoiceId}`);
    expect(next.body.data).toMatchObject({
      status: 'draft',
      invoiceDate: before,
      total: posted.body.data.total,
    });
  }, 600_000);
});
