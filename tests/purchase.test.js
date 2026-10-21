import { closeDatabase } from '../src/config/db.js';
import { StockBalance } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

let admin;
let manager;
let storekeeper;
let cashier;
let pcs;
let suppliers;
const wh = {};

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});
const P = '/api/v1/purchase';

let seq = 0;
async function newProduct(fields = {}) {
  seq += 1;
  const res = await as(admin).send('post', '/api/v1/products', {
    name: `Purchase test item ${Date.now()}-${seq}`,
    type: 'finished_good',
    baseUnitId: pcs,
    purchasePrice: '100',
    salePrice: '150',
    ...fields,
  });
  if (res.status !== 201) throw new Error(`product create failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const setPurchase = (settings) => as(admin).send('put', '/api/v1/settings/preferences/purchase', settings);
const balanceOf = async (warehouseId, productId) =>
  (await StockBalance.findOne({ where: { warehouseId, productId, variantId: null } }))?.toJSON();

/** Create a PO for one product and take it through approval. */
async function approvedOrder(
  productId,
  { quantity = '10', unitPrice = '100', supplier = suppliers[0] } = {},
) {
  const po = await as(admin).send('post', `${P}/orders`, {
    supplierId: supplier.id,
    warehouseId: wh['WH-TEJ'],
    items: [{ productId, quantity, unitPrice, taxGroupId: null }],
  });
  expect(po.status).toBe(201);
  const submitted = await as(admin).send('post', `${P}/orders/${po.body.data.id}/submit`);
  expect(submitted.body.data.status).toBe('approved');
  return submitted.body.data;
}

beforeAll(async () => {
  [admin, manager, storekeeper, cashier] = await Promise.all([
    login('admin@holydeen.com'),
    login('manager@holydeen.com'),
    login('storekeeper@holydeen.com'),
    login('cashier@holydeen.com'),
  ]);
  const lookups = await as(admin).get('/api/v1/products/lookups');
  pcs = lookups.body.data.units.find((u) => u.code === 'pcs').id;
  for (const w of (await as(admin).get('/api/v1/inventory/warehouses')).body.data) wh[w.code] = w.id;
  suppliers = (await as(admin).get('/api/v1/suppliers', { limit: 5, sort: 'name' })).body.data;
  // Most tests skip approval; the approval tests set their own levels.
  const res = await setPurchase({ approvalLevels: [], requisitionApproval: true, overReceiptPercent: 0 });
  if (res.status !== 200) throw new Error(`purchase settings: ${JSON.stringify(res.body)}`);
}, 180_000);

afterAll(async () => {
  await setPurchase({
    approvalLevels: [
      { name: 'Purchase manager', minAmount: '0', roleId: null },
      { name: 'Management', minAmount: '200000', roleId: null },
    ],
  });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('access', () => {
  it('needs purchase permissions', async () => {
    expect((await as(cashier).get(`${P}/orders`)).status).toBe(403);
    expect((await as(storekeeper).get(`${P}/orders`)).status).toBe(200);
  });
});

describe('approval levels by amount', () => {
  it('requires each level in turn, by different approvers', async () => {
    const roles = (await as(admin).get(`${P}/lookups`)).body.data.roles;
    const adminRole = roles.find((r) => r.slug === 'admin');
    expect(
      (
        await setPurchase({
          approvalLevels: [
            { name: 'Manager', minAmount: '0', roleId: null },
            { name: 'Director', minAmount: '50000', roleId: adminRole.id },
          ],
        })
      ).status,
    ).toBe(200);
    try {
      const p = await newProduct();
      const small = await as(admin).send('post', `${P}/orders`, {
        supplierId: suppliers[0].id,
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '10', unitPrice: '100' }],
      });
      const s1 = await as(admin).send('post', `${P}/orders/${small.body.data.id}/submit`);
      expect(s1.body.data).toMatchObject({ status: 'pending_approval', approvalLevel: 0 });
      expect(s1.body.data.approvalPlan).toHaveLength(1);
      expect((await as(storekeeper).send('post', `${P}/orders/${small.body.data.id}/approve`)).status).toBe(
        403,
      );
      const a1 = await as(manager).send('post', `${P}/orders/${small.body.data.id}/approve`);
      expect(a1.body.data.status).toBe('approved');

      const big = await as(admin).send('post', `${P}/orders`, {
        supplierId: suppliers[0].id,
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '600', unitPrice: '100' }],
      });
      const id = big.body.data.id;
      expect((await as(admin).send('post', `${P}/orders/${id}/submit`)).body.data.approvalPlan).toHaveLength(
        2,
      );
      expect((await as(manager).send('post', `${P}/orders/${id}/approve`)).body.data).toMatchObject({
        status: 'pending_approval',
        approvalLevel: 1,
      });
      // Level 2 needs the Admin role; the manager has neither the role nor may approve twice.
      expect((await as(manager).send('post', `${P}/orders/${id}/approve`)).status).toBe(403);
      // Reject sends it back to draft; history is kept.
      const rejected = await as(admin).send('post', `${P}/orders/${id}/reject`, {
        reason: 'Split the order',
      });
      expect(rejected.body.data).toMatchObject({ status: 'draft', rejectionReason: 'Split the order' });
      expect(rejected.body.data.approvals.map((a) => a.action)).toEqual(['approved', 'rejected']);
      await as(admin).send('post', `${P}/orders/${id}/submit`);
      await as(manager).send('post', `${P}/orders/${id}/approve`);
      const done = await as(admin).send('post', `${P}/orders/${id}/approve`);
      expect(done.body.data.status).toBe('approved');
    } finally {
      await setPurchase({ approvalLevels: [] });
    }
  }, 300_000);
});

describe('procure to pay', () => {
  it('PO → partial GRNs with landed cost → bill → payment → return / debit note → ledger & aging', async () => {
    const p = await newProduct();
    const supplier = suppliers[1];
    const po = await approvedOrder(p.id, { supplier });

    // First GRN: 6 of 10 with 60 freight → stock cost (600 + 60) / 6 = 110.
    const grn1 = await as(storekeeper).send('post', `${P}/orders/${po.id}/convert-to-receipt`);
    expect(grn1.status).toBe(201);
    const line = grn1.body.data.items[0];
    expect(line).toMatchObject({ quantity: '10.0000', orderItemId: po.items[0].id });
    const edited = await as(storekeeper).send('put', `${P}/receipts/${grn1.body.data.id}`, {
      supplierId: supplier.id,
      warehouseId: wh['WH-TEJ'],
      orderId: po.id,
      supplierReference: 'CH-1001',
      items: [{ orderItemId: line.orderItemId, productId: p.id, quantity: '6' }],
      costs: [{ costType: 'freight', amount: '60', allocation: 'value' }],
    });
    expect(edited.body.data).toMatchObject({
      goodsValue: '600.0000',
      landedCostTotal: '60.0000',
      totalCost: '660.0000',
    });
    expect(edited.body.data.items[0]).toMatchObject({ landedCost: '60.0000', unitCost: '110.0000' });
    const posted1 = await as(storekeeper).send('post', `${P}/receipts/${grn1.body.data.id}/post`);
    expect(posted1.body.data.status).toBe('posted');
    expect(await balanceOf(wh['WH-TEJ'], p.id)).toMatchObject({ quantity: '6.0000', totalValue: '660.0000' });
    expect((await as(admin).get(`${P}/orders/${po.id}`)).body.data.status).toBe('partially_received');

    // Second GRN takes the rest; receiving more than ordered is refused.
    const grn2 = await as(storekeeper).send('post', `${P}/orders/${po.id}/convert-to-receipt`);
    expect(grn2.body.data.items[0].quantity).toBe('4.0000');
    const over = await as(storekeeper).send('put', `${P}/receipts/${grn2.body.data.id}`, {
      supplierId: supplier.id,
      warehouseId: wh['WH-TEJ'],
      orderId: po.id,
      items: [{ orderItemId: line.orderItemId, productId: p.id, quantity: '5' }],
    });
    expect(over.status).toBe(200);
    expect((await as(storekeeper).send('post', `${P}/receipts/${grn2.body.data.id}/post`)).status).toBe(422);
    await as(storekeeper).send('put', `${P}/receipts/${grn2.body.data.id}`, {
      supplierId: supplier.id,
      warehouseId: wh['WH-TEJ'],
      orderId: po.id,
      items: [{ orderItemId: line.orderItemId, productId: p.id, quantity: '4' }],
    });
    expect((await as(storekeeper).send('post', `${P}/receipts/${grn2.body.data.id}/post`)).status).toBe(200);
    expect((await as(admin).get(`${P}/orders/${po.id}`)).body.data.status).toBe('received');

    // Bill everything received; the PO becomes billed.
    const bill = await as(admin).send('post', `${P}/orders/${po.id}/convert-to-bill`);
    expect(bill.status).toBe(201);
    expect(bill.body.data).toMatchObject({ total: '1000.0000', status: 'draft' });
    await as(admin).send('put', `${P}/bills/${bill.body.data.id}`, {
      supplierId: supplier.id,
      orderId: po.id,
      supplierInvoiceNo: `INV-${p.sku}`,
      items: bill.body.data.items.map((i) => ({
        orderItemId: i.orderItemId,
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        taxGroupId: null,
      })),
    });
    const postedBill = await as(admin).send('post', `${P}/bills/${bill.body.data.id}/post`);
    expect(postedBill.body.data.status).toBe('unpaid');
    expect((await as(admin).get(`${P}/orders/${po.id}`)).body.data.status).toBe('billed');
    // Nothing left to bill.
    expect((await as(admin).send('post', `${P}/orders/${po.id}/convert-to-bill`)).status).toBe(409);

    // Pay 400 against the bill.
    const methods = (await as(admin).get(`${P}/lookups`)).body.data.paymentMethods;
    const cash = methods.find((m) => !m.requiresReference);
    const payment = await as(admin).send('post', `${P}/payments`, {
      supplierId: supplier.id,
      paymentMethodId: cash.id,
      amount: '500',
      allocations: [{ billId: bill.body.data.id, amount: '400' }],
    });
    expect(payment.status).toBe(201);
    expect(payment.body.data).toMatchObject({ allocatedAmount: '400.0000', unallocated: '100.0000' });
    expect((await as(admin).get(`${P}/bills/${bill.body.data.id}`)).body.data).toMatchObject({
      status: 'partially_paid',
      balance: '600.0000',
    });

    // Return 2 units of the first receipt: stock out, debit note of 200 left as a credit.
    const ret = await as(storekeeper).send('post', `${P}/receipts/${grn1.body.data.id}/convert-to-return`);
    expect(ret.status).toBe(201);
    await as(storekeeper).send('put', `${P}/returns/${ret.body.data.id}`, {
      type: 'return',
      supplierId: supplier.id,
      warehouseId: wh['WH-TEJ'],
      receiptId: grn1.body.data.id,
      reason: 'Damaged on arrival',
      items: [
        {
          receiptItemId: ret.body.data.items[0].receiptItemId,
          productId: p.id,
          quantity: '2',
          unitPrice: '100',
        },
      ],
    });
    const postedReturn = await as(storekeeper).send('post', `${P}/returns/${ret.body.data.id}/post`);
    expect(postedReturn.body.data).toMatchObject({
      status: 'posted',
      total: '200.0000',
      unapplied: '200.0000',
    });
    expect((await balanceOf(wh['WH-TEJ'], p.id)).quantity).toBe('8.0000');

    // Apply the debit note and the advance to the bill → paid.
    await as(admin).send('post', `${P}/payables/apply-credit`, {
      sourceType: 'debit_note',
      sourceId: ret.body.data.id,
      allocations: [{ billId: bill.body.data.id, amount: '200' }],
    });
    const open = await as(admin).get(`${P}/suppliers/${supplier.id}/open-items`);
    expect(
      open.body.data.credits.find((c) => c.sourceType === 'payment' && c.id === payment.body.data.id)
        .available,
    ).toBe('100.0000');
    await as(admin).send('post', `${P}/payables/apply-credit`, {
      sourceType: 'payment',
      sourceId: payment.body.data.id,
      allocations: [{ billId: bill.body.data.id, amount: '100' }],
    });
    const afterCredits = await as(admin).get(`${P}/bills/${bill.body.data.id}`);
    expect(afterCredits.body.data).toMatchObject({ status: 'partially_paid', balance: '300.0000' });

    // Ledger: bill credit 1000, payment 500 and debit note 200 on the debit side.
    const ledger = await as(admin).get(`${P}/suppliers/${supplier.id}/ledger`);
    const mine = ledger.body.data.entries.filter((e) =>
      [bill.body.data.number, payment.body.data.number, ret.body.data.number].includes(e.number),
    );
    expect(mine.map((e) => [e.type, e.credit, e.debit])).toEqual([
      ['bill', '1000.0000', '0.0000'],
      ['payment', '0.0000', '500.0000'],
      ['return', '0.0000', '200.0000'],
    ]);

    // Aging: the bill is not due yet (30-day terms) → "current".
    const aging = await as(admin).get(`${P}/payables/aging`, { supplierId: supplier.id });
    expect(aging.status).toBe(200);
    expect(Number(aging.body.data.rows[0].current)).toBeGreaterThanOrEqual(300);
    const byBillDate = await as(admin).get(`${P}/payables/aging`, {
      supplierId: supplier.id,
      basis: 'bill_date',
    });
    expect(Number(byBillDate.body.data.rows[0].d0_30)).toBeGreaterThanOrEqual(300);

    // Voiding the payment reopens the bill.
    const voided = await as(manager).send('post', `${P}/payments/${payment.body.data.id}/void`, {
      reason: 'Wrong supplier',
    });
    expect(voided.body.data.status).toBe('void');
    expect((await as(admin).get(`${P}/bills/${bill.body.data.id}`)).body.data.balance).toBe('800.0000');
  }, 600_000);
});

describe('requisition → RFQ → award → PO', () => {
  it('converts without re-entering lines', async () => {
    const p = await newProduct();
    const req = await as(storekeeper).send('post', `${P}/requisitions`, {
      warehouseId: wh['WH-TEJ'],
      items: [{ productId: p.id, quantity: '20' }],
    });
    expect(req.status).toBe(201);
    const submitted = await as(storekeeper).send('post', `${P}/requisitions/${req.body.data.id}/submit`);
    expect(submitted.body.data.status).toBe('pending_approval');
    expect((await as(storekeeper).send('post', `${P}/requisitions/${req.body.data.id}/approve`)).status).toBe(
      403,
    );
    await as(manager).send('post', `${P}/requisitions/${req.body.data.id}/approve`);

    const rfq = await as(admin).send('post', `${P}/requisitions/${req.body.data.id}/convert-to-rfq`, {
      supplierIds: [suppliers[0].id, suppliers[1].id],
    });
    expect(rfq.status).toBe(201);
    expect(rfq.body.data.items[0]).toMatchObject({ quantity: '20.0000' });
    const id = rfq.body.data.id;
    await as(admin).send('post', `${P}/rfqs/${id}/send`);
    const [s0, s1] = rfq.body.data.suppliers;
    const itemId = rfq.body.data.items[0].id;
    await as(admin).send('put', `${P}/rfqs/${id}/suppliers/${s0.id}/quote`, {
      quotes: [{ rfqItemId: itemId, unitPrice: '95' }],
    });
    const quoted = await as(admin).send('put', `${P}/rfqs/${id}/suppliers/${s1.id}/quote`, {
      quotes: [{ rfqItemId: itemId, unitPrice: '90', discountPercent: '0' }],
      deliveryDays: 3,
    });
    expect(quoted.body.data.bestQuotes[itemId]).toMatchObject({ unitPrice: '90.0000', rfqSupplierId: s1.id });

    const award = await as(manager).send('post', `${P}/rfqs/${id}/award`, { rfqSupplierId: s1.id });
    expect(award.status).toBe(201);
    const po = await as(admin).get(`${P}/orders/${award.body.data.id}`);
    expect(po.body.data).toMatchObject({ status: 'draft', supplierId: s1.supplierId, total: '1800.0000' });
    expect(po.body.data.requisition.number).toBe(req.body.data.number);
    expect((await as(admin).get(`${P}/requisitions/${req.body.data.id}`)).body.data.status).toBe('ordered');
    expect((await as(admin).get(`${P}/rfqs/${id}`)).body.data.status).toBe('awarded');
  }, 300_000);
});

describe('print and email', () => {
  it('returns print data and emails the PDF', async () => {
    const p = await newProduct();
    const po = await approvedOrder(p.id);
    const print = await as(admin).get(`${P}/orders/${po.id}/print`);
    expect(print.body.data.template.options.title).toBe('Purchase Order');
    expect(print.body.data.company.name).toBeTruthy();
    const pdf = Buffer.from('%PDF-1.4\n%test\n').toString('base64');
    const sent = await as(admin).send('post', `${P}/orders/${po.id}/email`, {
      to: ['supplier@example.com'],
      subject: `Purchase order ${po.number}`,
      message: 'Please find our order attached.',
      pdfBase64: pdf,
      filename: `${po.number}.pdf`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body.data.emailedAt).toBeTruthy();
    const notPdf = await as(admin).send('post', `${P}/orders/${po.id}/email`, {
      to: ['supplier@example.com'],
      subject: 'x',
      pdfBase64: Buffer.from('hello').toString('base64'),
      filename: 'x.pdf',
    });
    expect(notPdf.status).toBe(422);
  }, 300_000);
});

describe('calculate', () => {
  it('prices lines with discount and tax groups on the server', async () => {
    const lookups = (await as(admin).get(`${P}/lookups`)).body.data;
    const vat15 = lookups.taxGroups.find((g) => g.rate === '15.00');
    const res = await as(admin).send('post', `${P}/calculate`, {
      items: [{ quantity: '2', unitPrice: '500', discountPercent: '10', taxGroupId: vat15?.id ?? null }],
    });
    expect(res.body.data.totals).toMatchObject({
      subtotal: '1000.0000',
      discountTotal: '100.0000',
      total: vat15 ? '1035.0000' : '900.0000',
    });
  });
});
