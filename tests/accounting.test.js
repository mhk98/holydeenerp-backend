import { closeDatabase } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { monthlyPeriods } from '../src/modules/accounting/fiscal.service.js';
import { roleOpening } from '../src/modules/parties/party-balance.js';
import { api, bearer, login } from './helpers.js';

let admin;
let accountant;
let storekeeper;
let pcs;
let vat15;
let cash;
const wh = {};
const acc = {};
const A = '/api/v1/accounting';

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});

let seq = 0;
const unique = (label) => `${label} ${Date.now()}-${(seq += 1)}`;

async function created(res, what) {
  if (![200, 201].includes(res.status)) throw new Error(`${what} failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const newProduct = () =>
  as(admin)
    .send('post', '/api/v1/products', {
      name: unique('Ledger test item'),
      type: 'finished_good',
      baseUnitId: pcs,
      purchasePrice: '60',
      salePrice: '100',
    })
    .then((r) => created(r, 'product'));

const newParty = (kind, fields = {}) =>
  as(admin)
    .send('post', `/api/v1/${kind}s`, { name: unique(`Ledger test ${kind}`), ...fields })
    .then((r) => created(r, kind));

async function stockIn(productId, quantity, unitCost) {
  const adj = await created(
    await as(admin).send('post', '/api/v1/inventory/adjustments', {
      kind: 'adjustment',
      warehouseId: wh['WH-TEJ'],
      items: [{ productId, direction: 'in', quantity, unitCost }],
    }),
    'adjustment',
  );
  return created(await as(admin).send('post', `/api/v1/inventory/adjustments/${adj.id}/submit`), 'stock in');
}

const journalsOf = async (sourceType, id) =>
  (await as(accountant).get(`${A}/journals/source/${sourceType}/${id}`)).body.data;

/** Net debit − credit per account code over some journals. */
function net(journals) {
  const out = {};
  for (const j of journals) {
    for (const l of j.lines) {
      out[l.account.code] = Number(
        ((out[l.account.code] ?? 0) + Number(l.debit) - Number(l.credit)).toFixed(4),
      );
    }
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

const balanced = (j) => expect(Number(j.totalDebit)).toBeCloseTo(Number(j.totalCredit), 4);

beforeAll(async () => {
  [admin, accountant, storekeeper] = await Promise.all([
    login('admin@holydeen.com'),
    login('accountant@holydeen.com'),
    login('storekeeper@holydeen.com'),
  ]);
  pcs = (await as(admin).get('/api/v1/products/lookups')).body.data.units.find((u) => u.code === 'pcs').id;
  const lookups = (await as(admin).get('/api/v1/purchase/lookups')).body.data;
  vat15 = lookups.taxGroups.find((g) => g.rate === '15.00');
  cash = lookups.paymentMethods.find((m) => m.type === 'cash') ?? lookups.paymentMethods[0];
  for (const w of (await as(admin).get('/api/v1/inventory/warehouses')).body.data) wh[w.code] = w.id;
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', { requireApproval: false });
  for (const a of (await as(accountant).get(`${A}/accounts/options`)).body.data) acc[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', { requireApproval: true });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('access', () => {
  it('needs accounting permissions', async () => {
    expect((await as(storekeeper).get(`${A}/journals`)).status).toBe(403);
    expect((await as(storekeeper).get(`${A}/accounts/tree`)).status).toBe(403);
    expect((await as(accountant).get(`${A}/journals`)).status).toBe(200);
  });
});

describe('chart of accounts', () => {
  it('seeds the standard chart as a tree', async () => {
    const tree = (await as(accountant).get(`${A}/accounts/tree`, { balances: 'true' })).body.data;
    expect(tree.map((n) => n.code)).toEqual(['1000', '2000', '3000', '4000', '5000']);
    const current = tree[0].children.find((n) => n.code === '1100');
    expect(current.children.map((n) => n.code)).toEqual(expect.arrayContaining(['1110', '1150', '1160']));
    expect(current.balance).toEqual(expect.any(String));
  });

  it('adds groups and ledgers that inherit the type, and protects system accounts', async () => {
    const expenses = (await as(accountant).get(`${A}/accounts`, { search: 'Operating Expenses' })).body
      .data[0];
    const group = await created(
      await as(accountant).send('post', `${A}/accounts`, {
        code: `54${seq}${Date.now() % 1000}`,
        name: 'Administrative Expenses',
        parentId: expenses.id,
        isGroup: true,
      }),
      'group',
    );
    expect(group).toMatchObject({ type: 'expense', subtype: 'expense', isGroup: true });
    const ledger = await created(
      await as(accountant).send('post', `${A}/accounts`, {
        code: `${group.code}1`,
        name: 'Printing & Stationery',
        parentId: group.id,
      }),
      'ledger',
    );
    expect(ledger.type).toBe('expense');
    const wrongType = await as(accountant).send('post', `${A}/accounts`, {
      code: `${group.code}2`,
      name: 'Misfiled',
      parentId: group.id,
      type: 'income',
    });
    expect(wrongType.status).toBe(422);
    expect((await as(accountant).send('delete', `${A}/accounts/${acc['1150']}`)).status).toBe(409);
    expect((await as(accountant).send('delete', `${A}/accounts/${group.id}`)).status).toBe(409);
    expect((await as(accountant).send('delete', `${A}/accounts/${ledger.id}`)).status).toBe(200);
  });
});

describe('manual journals', () => {
  const entry = (lines, extra = {}) => ({
    entryDate: new Date().toISOString().slice(0, 10),
    lines,
    ...extra,
  });

  it('must balance, use ledger accounts and name the party on receivables', async () => {
    const unbalanced = await as(accountant).send(
      'post',
      `${A}/journals`,
      entry([
        { accountId: acc['5220'], debit: '100' },
        { accountId: acc['1110'], credit: '90' },
      ]),
    );
    expect(unbalanced.status).toBe(422);
    const groups = (await as(accountant).get(`${A}/accounts`, { isGroup: 'true', search: 'Current Assets' }))
      .body.data;
    const onGroup = await as(accountant).send(
      'post',
      `${A}/journals`,
      entry([
        { accountId: groups[0].id, debit: '100' },
        { accountId: acc['1110'], credit: '100' },
      ]),
    );
    expect(onGroup.status).toBe(422);
    const noParty = await as(accountant).send(
      'post',
      `${A}/journals`,
      entry([
        { accountId: acc['1150'], debit: '100' },
        { accountId: acc['4330'], credit: '100' },
      ]),
    );
    expect(noParty.status).toBe(422);
    expect(noParty.body.errors[0].field).toBe('lines.0.partyId');
  });

  it('saves a draft, posts it and corrects it with a reversing entry', async () => {
    const draft = await created(
      await as(accountant).send(
        'post',
        `${A}/journals`,
        entry(
          [
            { accountId: acc['5240'], debit: '2500', description: 'Grameenphone' },
            { accountId: acc['1110'], credit: '2500' },
          ],
          { narration: 'Phone bill', reference: 'GP-881' },
        ),
      ),
      'draft',
    );
    expect(draft).toMatchObject({ status: 'draft', entryType: 'manual', totalDebit: '2500.0000' });
    const posted = await created(await as(accountant).send('post', `${A}/journals/${draft.id}/post`), 'post');
    expect(posted.status).toBe('posted');
    expect((await as(accountant).send('put', `${A}/journals/${draft.id}`, entry(posted.lines))).status).toBe(
      409,
    );

    const reversal = await created(
      await as(accountant).send('post', `${A}/journals/${draft.id}/reverse`, {}),
      'reverse',
    );
    expect(reversal).toMatchObject({ entryType: 'reversal', reversalOf: { id: draft.id } });
    expect(net([posted, reversal])).toEqual({});
    expect((await as(accountant).send('post', `${A}/journals/${draft.id}/reverse`, {})).status).toBe(409);
  });
});

describe('automatic postings', () => {
  let product;
  let customer;

  it('values stock adjustments at cost', async () => {
    product = await newProduct();
    const adj = await stockIn(product.id, '10', '60');
    const [j] = await journalsOf('stock_adjustment', adj.id);
    expect(j).toMatchObject({ entryType: 'auto', event: 'stock:adjustment_in', status: 'posted' });
    expect(net([j])).toEqual({ 1160: 600, 5160: -600 });
  }, 120_000);

  it('posts a sale (revenue, VAT, cost of goods) and its receipt; voiding reverses the receipt', async () => {
    customer = await newParty('customer');
    const draft = await created(
      await as(admin).send('post', '/api/v1/sales/invoices', {
        customerId: customer.id,
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: product.id, quantity: '3', unitPrice: '100', taxGroupId: vat15?.id ?? null }],
      }),
      'invoice',
    );
    const inv = await created(
      await as(admin).send('post', `/api/v1/sales/invoices/${draft.id}/post`, {}),
      'post',
    );
    const journals = await journalsOf('sales_invoice', inv.id);
    expect(journals.map((j) => j.event).sort()).toEqual(['post', 'stock:sale']);
    journals.forEach(balanced);
    const doc = journals.find((j) => j.event === 'post');
    const total = Number(inv.total);
    const lines = net([doc]);
    expect(lines['1150']).toBeCloseTo(total, 4);
    expect(lines['4100']).toBeCloseTo(-300, 4);
    expect(lines['2140']).toBeCloseTo(-45, 4);
    expect(doc.lines.find((l) => l.account.code === '1150').party.id).toBe(customer.id);
    expect(net(journals.filter((j) => j.event === 'stock:sale'))).toEqual({ 1160: -180, 5100: 180 });

    const receipt = await created(
      await as(admin).send('post', '/api/v1/sales/receipts', {
        customerId: customer.id,
        paymentMethodId: cash.id,
        amount: inv.total,
        allocations: [{ invoiceId: inv.id, amount: inv.total }],
      }),
      'receipt',
    );
    const [rj] = await journalsOf('customer_receipt', receipt.id);
    expect(net([rj])['1150']).toBeCloseTo(-total, 4);
    await created(
      await as(admin).send('post', `/api/v1/sales/receipts/${receipt.id}/void`, { reason: 'Bounced' }),
      'void',
    );
    const after = await journalsOf('customer_receipt', receipt.id);
    expect(after.map((j) => j.entryType)).toEqual(['auto', 'reversal']);
    expect(net(after)).toEqual({});
  }, 300_000);

  it('posts a goods receipt with landed cost, the bill and the payment', async () => {
    const supplier = await newParty('supplier');
    const p = await newProduct();
    const grn = await created(
      await as(admin).send('post', '/api/v1/purchase/receipts', {
        supplierId: supplier.id,
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '5', unitPrice: '80' }],
        costs: [{ costType: 'freight', amount: '30', allocation: 'value' }],
      }),
      'grn',
    );
    await created(await as(admin).send('post', `/api/v1/purchase/receipts/${grn.id}/post`), 'grn post');
    expect(net(await journalsOf('goods_receipt', grn.id))).toEqual({ 1160: 430, 2120: -400, 2130: -30 });

    const bill = await created(
      await as(admin).send('post', `/api/v1/purchase/receipts/${grn.id}/convert-to-bill`),
      'bill',
    );
    await created(await as(admin).send('post', `/api/v1/purchase/bills/${bill.id}/post`), 'bill post');
    expect(net(await journalsOf('supplier_bill', bill.id))).toEqual({ 2110: -400, 2120: 400 });

    const payment = await created(
      await as(admin).send('post', '/api/v1/purchase/payments', {
        supplierId: supplier.id,
        paymentMethodId: cash.id,
        amount: '400',
        allocations: [{ billId: bill.id, amount: '400' }],
      }),
      'payment',
    );
    const paid = net(await journalsOf('supplier_payment', payment.id));
    expect(paid['2110']).toBe(400);
    expect(Object.values(paid).reduce((s, v) => s + v, 0)).toBe(0);
  }, 300_000);

  it("posts a party's opening balance and re-posts it when it changes", async () => {
    const c = await newParty('customer', { openingBalance: '1500', openingBalanceType: 'debit' });
    expect(net(await journalsOf('party', c.id))).toEqual({ 1150: 1500, 3300: -1500 });
    await created(
      await as(admin).send('patch', `/api/v1/customers/${c.id}`, { openingBalance: '2000' }),
      'edit',
    );
    expect(net(await journalsOf('party', c.id))).toEqual({ 1150: 2000, 3300: -2000 });
  }, 120_000);
});

describe('opening balance of a party with both roles', () => {
  const party = (type, roles) => ({ openingBalance: '1000', openingBalanceType: type, ...roles });
  const both = { isCustomer: true, isSupplier: true };
  it('counts it once: a debit as receivable, a credit as payable', () => {
    expect(roleOpening(party('debit', both), 'customer').toNumber()).toBe(1000);
    expect(roleOpening(party('debit', both), 'supplier').toNumber()).toBe(0);
    expect(roleOpening(party('credit', both), 'customer').toNumber()).toBe(0);
    expect(roleOpening(party('credit', both), 'supplier').toNumber()).toBe(1000);
  });
  it('keeps the whole balance in the only role (an advance shows as negative)', () => {
    expect(roleOpening(party('credit', { isCustomer: true }), 'customer').toNumber()).toBe(-1000);
    expect(roleOpening(party('debit', { isSupplier: true }), 'supplier').toNumber()).toBe(-1000);
  });
});

describe('account mapping', () => {
  it('routes postings to the chosen account and validates the type', async () => {
    const mapping = (await as(accountant).get(`${A}/mapping`)).body.data;
    expect(mapping.groups.sales.find((m) => m.key === 'sales')).toMatchObject({
      isDefault: true,
      account: { code: '4100' },
    });
    expect(mapping.paymentMethods.length).toBeGreaterThan(0);
    const wrong = await as(accountant).send('put', `${A}/mapping`, { accounts: { sales: acc['5220'] } });
    expect(wrong.status).toBe(422);

    const saved = await created(
      await as(accountant).send('put', `${A}/mapping`, { accounts: { sales: acc['4200'] } }),
      'mapping',
    );
    expect(saved.groups.sales.find((m) => m.key === 'sales')).toMatchObject({ account: { code: '4200' } });
    const p = await newProduct();
    await stockIn(p.id, '2', '60');
    const c = await newParty('customer');
    const draft = await created(
      await as(admin).send('post', '/api/v1/sales/invoices', {
        customerId: c.id,
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '1', unitPrice: '100' }],
      }),
      'invoice',
    );
    await created(await as(admin).send('post', `/api/v1/sales/invoices/${draft.id}/post`, {}), 'post');
    const doc = (await journalsOf('sales_invoice', draft.id)).find((j) => j.event === 'post');
    expect(net([doc])['4200']).toBe(-100);
    await created(await as(accountant).send('put', `${A}/mapping`, { accounts: { sales: null } }), 'restore');
  }, 300_000);
});

describe('opening balances', () => {
  it('puts the difference on opening balance equity and replaces the previous entry', async () => {
    const date = '2026-07-01';
    const first = await created(
      await as(accountant).send('put', `${A}/opening-balances`, {
        date,
        lines: [{ accountId: acc['1210'], debit: '50000' }],
      }),
      'opening',
    );
    expect(net([first])).toEqual({ 1210: 50000, 3300: -50000 });
    const second = await created(
      await as(accountant).send('put', `${A}/opening-balances`, {
        date,
        lines: [
          { accountId: acc['1210'], debit: '60000' },
          { accountId: acc['2210'], credit: '20000' },
        ],
      }),
      'opening',
    );
    expect(net([second])).toEqual({ 1210: 60000, 2210: -20000, 3300: -40000 });
    expect((await as(accountant).get(`${A}/opening-balances`)).body.data.id).toBe(second.id);
    const firstNow = (await as(accountant).get(`${A}/journals/${first.id}`)).body.data;
    expect(firstNow.reversedBy).not.toBeNull();
    const receivable = await as(accountant).send('put', `${A}/opening-balances`, {
      date,
      lines: [{ accountId: acc['1150'], debit: '10' }],
    });
    expect(receivable.status).toBe(422);
  }, 120_000);
});

describe('fiscal years and period locks', () => {
  it('splits a year into monthly periods', () => {
    const periods = monthlyPeriods('2026-07-01', '2027-06-30');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ name: 'Jul 2026', startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(periods[7]).toMatchObject({ name: 'Feb 2027', endDate: '2027-02-28' });
  });

  it('refuses postings in a locked period, documents included', async () => {
    const years = (await as(accountant).get(`${A}/fiscal-years`)).body.data;
    const current = years.find((y) => y.status === 'open' && y.periods.length === 12);
    expect(current).toBeDefined();
    const july = current.periods[0];
    expect((await as(admin).send('patch', `${A}/periods/${july.id}`, { status: 'locked' })).status).toBe(200);

    const late = await as(accountant).send('post', `${A}/journals`, {
      entryDate: july.startDate,
      post: true,
      lines: [
        { accountId: acc['5220'], debit: '10' },
        { accountId: acc['1110'], credit: '10' },
      ],
    });
    expect(late.status).toBe(422);
    expect(late.body.message).toMatch(/locked/);

    const p = await newProduct();
    await stockIn(p.id, '1', '60');
    const c = await newParty('customer');
    const draft = await created(
      await as(admin).send('post', '/api/v1/sales/invoices', {
        customerId: c.id,
        warehouseId: wh['WH-TEJ'],
        invoiceDate: july.startDate,
        items: [{ productId: p.id, quantity: '1', unitPrice: '100' }],
      }),
      'invoice',
    );
    const blocked = await as(admin).send('post', `/api/v1/sales/invoices/${draft.id}/post`, {});
    expect(blocked.status).toBe(422);
    expect((await as(admin).get(`/api/v1/sales/invoices/${draft.id}`)).body.data.status).toBe('draft');

    expect((await as(admin).send('patch', `${A}/periods/${july.id}`, { status: 'open' })).status).toBe(200);
    expect((await as(admin).send('post', `/api/v1/sales/invoices/${draft.id}/post`, {})).status).toBe(200);
  }, 300_000);

  it('closes a year into retained earnings and reopens it', async () => {
    const year = await created(
      await as(accountant).send('post', `${A}/fiscal-years`, { startDate: '2024-07-01' }),
      'year',
    );
    expect(year).toMatchObject({ name: 'FY 2024-25', endDate: '2025-06-30' });
    expect(year.periods).toHaveLength(12);
    expect((await as(accountant).send('post', `${A}/fiscal-years`, { startDate: '2025-01-01' })).status).toBe(
      422,
    );

    await created(
      await as(accountant).send('post', `${A}/journals`, {
        entryDate: '2025-01-15',
        post: true,
        narration: 'FDR interest',
        lines: [
          { accountId: acc['1120'], debit: '1000' },
          { accountId: acc['4330'], credit: '1000' },
        ],
      }),
      'interest',
    );
    const closed = await created(
      await as(accountant).send('post', `${A}/fiscal-years/${year.id}/close`),
      'close',
    );
    expect(closed.status).toBe('closed');
    expect(closed.periods.every((p) => p.status === 'locked')).toBe(true);
    const [closing] = await journalsOf('fiscal_year', year.id);
    expect(closing).toMatchObject({ entryType: 'closing', entryDate: '2025-06-30' });
    expect(net([closing])).toEqual({ 3200: -1000, 4330: 1000 });
    expect(
      (await as(accountant).send('patch', `${A}/periods/${year.periods[0].id}`, { status: 'open' })).status,
    ).toBe(409);

    const reopened = await created(
      await as(accountant).send('post', `${A}/fiscal-years/${year.id}/reopen`),
      'reopen',
    );
    expect(reopened.status).toBe('open');
    expect(net(await journalsOf('fiscal_year', year.id))).toEqual({});
  }, 300_000);
});

describe('ledger health check', () => {
  it('agrees with receivables, payables and stock', async () => {
    const res = await as(accountant).get(`${A}/reconciliation`);
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.trialBalance.balanced).toBe(true);
    expect(r.unbalancedJournals).toBe(0);
    expect(r.receivables).toMatchObject({ balanced: true, mismatches: [] });
    expect(r.payables).toMatchObject({ balanced: true, mismatches: [] });
    expect(r.inventory.balanced).toBe(true);
    expect(r.inTransit.balanced).toBe(true);
    expect(r.ok).toBe(true);
  }, 120_000);

  it('rebuilds nothing twice', async () => {
    const res = await as(admin).send('post', `${A}/backfill`);
    expect(res.status).toBe(200);
    expect(res.body.data.posted).toEqual({});
  }, 300_000);
});
