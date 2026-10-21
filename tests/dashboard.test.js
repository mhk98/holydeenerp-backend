import { QueryTypes } from 'sequelize';
import { closeDatabase, sequelize } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

/** Dashboard: KPIs agree with the ledger and documents, parts follow permissions, branch filter, cache. */

let admin;
let cashier;
let storekeeper;
let production;
const D = '/api/v1/dashboard';
const get = (user, path, q = {}) => api().get(`${D}${path}`).query(q).set(bearer(user.token));

async function ok(res, what) {
  if (res.status !== 200) throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}
const one = async (sql, replacements) =>
  (await sequelize.query(sql, { replacements, type: QueryTypes.SELECT }))[0];

beforeAll(async () => {
  [admin, cashier, storekeeper, production] = await Promise.all([
    login('admin@holydeen.com'),
    login('cashier@holydeen.com'),
    login('storekeeper@holydeen.com'),
    login('production@holydeen.com'),
  ]);
}, 180_000);

afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('KPIs', () => {
  it('match the posted documents and stock for a custom period', async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const data = await ok(await get(admin, '/kpis', { range: 'custom', from, to, refresh: 'true' }), 'kpis');
    const { companyId } = admin.user;

    const bills = await one(
      `SELECT COALESCE(SUM(subtotal - discount_total), 0) AS v FROM supplier_bills
        WHERE company_id = ? AND deleted_at IS NULL AND status IN ('unpaid', 'partially_paid', 'paid')
          AND bill_date BETWEEN ? AND ?`,
      [companyId, from, to],
    );
    expect(Number(data.kpis.purchases.value)).toBeCloseTo(Number(bills.v), 2);

    const stock = await one(
      `SELECT COALESCE(SUM(total_value), 0) AS v FROM stock_balances WHERE company_id = ?`,
      [companyId],
    );
    expect(Number(data.kpis.stockValue.value)).toBeCloseTo(Number(stock.v), 2);

    for (const k of ['sales', 'grossProfit', 'receivables', 'payables', 'cashBalance', 'pendingProduction'])
      expect(data.kpis[k]).toHaveProperty('value');
    // Net sales = revenue less returns in the ledger (year-closing entries left out).
    const revenue = await one(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS v FROM journal_lines l
         JOIN journal_entries j ON j.id = l.journal_id JOIN accounts a ON a.id = l.account_id
        WHERE l.company_id = ? AND j.status = 'posted' AND j.deleted_at IS NULL AND j.entry_type <> 'closing'
          AND a.type = 'income' AND a.subtype IN ('revenue', 'contra_revenue') AND j.entry_date BETWEEN ? AND ?`,
      [companyId, from, to],
    );
    expect(Number(data.kpis.sales.value)).toBeCloseTo(Number(revenue.v), 2);
    expect(data.period).toMatchObject({ from, to, bucket: 'month' });
  }, 180_000);

  it('compares with the previous period of the same length', async () => {
    const data = await ok(await get(admin, '/kpis', { range: 'week' }), 'week');
    const { from, to, previous } = data.period;
    const len = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
    expect(len(previous.from, previous.to)).toBe(len(from, to));
    expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(6); // Saturday
    expect(data.kpis.sales).toHaveProperty('changePercent');
  }, 120_000);

  it('rejects a branch the user cannot see and a bad custom range', async () => {
    const branch = await one("SELECT id FROM branches WHERE code = 'CTG' AND company_id = ?", [
      storekeeper.user.companyId,
    ]);
    expect((await get(storekeeper, '/kpis', { branchId: branch.id })).status).toBe(403);
    expect((await get(admin, '/kpis', { range: 'custom', from: '2026-05-01' })).status).toBe(422);
    expect(
      (await get(admin, '/kpis', { range: 'custom', from: '2026-05-02', to: '2026-05-01' })).status,
    ).toBe(422);
  }, 60_000);
});

describe('role-based parts', () => {
  it('shows a cashier only their POS day', async () => {
    const kpis = await ok(await get(cashier, '/kpis'), 'cashier kpis');
    expect(kpis.kpis).toEqual({});
    const widgets = await ok(await get(cashier, '/widgets'), 'cashier widgets');
    expect(widgets.widgets).toHaveProperty('mySales');
    expect(widgets.widgets).not.toHaveProperty('overdueInvoices');
    expect(widgets.widgets).not.toHaveProperty('pendingApprovals');
  }, 60_000);

  it('shows a store keeper stock, not money', async () => {
    const kpis = await ok(await get(storekeeper, '/kpis'), 'store kpis');
    expect(kpis.kpis).toHaveProperty('stockValue');
    expect(kpis.kpis).not.toHaveProperty('grossProfit');
    expect(kpis.kpis).not.toHaveProperty('sales');
    const widgets = await ok(await get(storekeeper, '/widgets'), 'store widgets');
    expect(widgets.widgets).not.toHaveProperty('overdueInvoices');
    expect(widgets.widgets.pendingApprovals).toBeUndefined(); // no inventory.approve
  }, 60_000);

  it('shows a production manager the production parts', async () => {
    const kpis = await ok(await get(production, '/kpis'), 'production kpis');
    expect(Object.keys(kpis.kpis)).toEqual(expect.arrayContaining(['pendingProduction', 'stockValue']));
    const charts = await ok(await get(production, '/charts'), 'production charts');
    expect(charts.charts.productionOutput.length).toBeGreaterThan(0);
    expect(charts.charts).not.toHaveProperty('monthlyProfit');
  }, 60_000);
});

describe('charts and widgets', () => {
  it('returns gap-free series and the admin widgets', async () => {
    const charts = await ok(await get(admin, '/charts', { range: 'month' }), 'charts');
    const { from, to } = charts.period;
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    expect(charts.charts.salesVsPurchases).toHaveLength(days);
    expect(charts.charts.monthlyProfit).toHaveLength(12);
    expect(charts.charts.topProducts.length).toBeLessThanOrEqual(10);

    const widgets = await ok(await get(admin, '/widgets', { refresh: 'true' }), 'widgets');
    expect(widgets.widgets).toHaveProperty('overdueInvoices.count');
    expect(Array.isArray(widgets.widgets.recentActivity)).toBe(true);
    expect(widgets.widgets.assetMaintenance).toMatchObject({ available: false });
    for (const a of widgets.widgets.pendingApprovals ?? []) expect(a.approvePath).toMatch(/\/approve$/);
  }, 120_000);

  it('serves repeated requests from the cache until refresh=true', async () => {
    const q = { range: 'today' };
    const before = await ok(await get(admin, '/kpis', { ...q, refresh: 'true' }), 'fresh');
    const hamper = await one(
      "SELECT id FROM products WHERE name = 'Holydeen Eid Gift Hamper — Classic' AND company_id = ?",
      [admin.user.companyId],
    );
    const wh = await one("SELECT id FROM warehouses WHERE code = 'WH-TEJ' AND company_id = ?", [
      admin.user.companyId,
    ]);
    const mo = await api()
      .post('/api/v1/manufacturing/orders')
      .set(bearer(admin.token))
      .send({ productId: hamper.id, quantity: '2', rawWarehouseId: wh.id });
    expect(mo.status).toBe(201);
    const count = (d) => Number(d.kpis.pendingProduction.value);
    expect(count(await ok(await get(admin, '/kpis', q), 'cached'))).toBe(count(before));
    expect(count(await ok(await get(admin, '/kpis', { ...q, refresh: 'true' }), 'refreshed'))).toBe(
      count(before) + 1,
    );
  }, 120_000);

  it('needs dashboard.view', async () => {
    expect((await api().get(`${D}/kpis`)).status).toBe(401);
  });
});
