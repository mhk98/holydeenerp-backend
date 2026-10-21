import { closeDatabase } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

/**
 * Financial reports. The test posts its own journals in March 2023 (a period no other test uses),
 * so every figure is known:
 *   capital 100,000 into the bank · cash sale 5,000 · rent 1,000 from cash · cost of goods 2,000
 *   furniture 20,000 from the bank · bank loan 30,000
 */

let accountant;
let storekeeper;
const acc = {};
const A = '/api/v1/accounting';
const R = `${A}/reports`;
const MARCH = { from: '2023-03-01', to: '2023-03-31' };

const as = (user) => ({
  get: (u, q) =>
    api()
      .get(u)
      .query(q ?? {})
      .set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});

async function journal(entryDate, debit, credit, amount, narration) {
  const res = await as(accountant).send('post', `${A}/journals`, {
    entryDate,
    narration,
    post: true,
    lines: [
      { accountId: acc[debit].id, debit: amount, credit: '0' },
      { accountId: acc[credit].id, debit: '0', credit: amount },
    ],
  });
  if (res.status !== 201) throw new Error(`journal failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const amountOf = (section, code) => Number(section.rows.find((r) => r.code === code)?.amount ?? 0);
const report = async (name, query) => {
  const res = await as(accountant).get(`${R}/${name}`, query);
  if (res.status !== 200) throw new Error(`${name} failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

beforeAll(async () => {
  [accountant, storekeeper] = await Promise.all([
    login('accountant@holydeen.com'),
    login('storekeeper@holydeen.com'),
  ]);
  for (const a of (await as(accountant).get(`${A}/accounts/options`)).body.data) acc[a.code] = a;
  await journal('2023-03-01', '1120', '3100', '100000', 'Capital');
  await journal('2023-03-05', '1110', '4100', '5000', 'Cash sale');
  await journal('2023-03-06', '5220', '1110', '1000', 'Rent');
  await journal('2023-03-06', '5100', '1160', '2000', 'Cost of goods');
  await journal('2023-03-10', '1210', '1120', '20000', 'Furniture');
  await journal('2023-03-20', '1120', '2210', '30000', 'Bank loan');
}, 240_000);

afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('financial reports', () => {
  it('need accounting permissions', async () => {
    expect((await as(storekeeper).get(`${R}/trial-balance`)).status).toBe(403);
  });

  it('profit & loss with a comparison period', async () => {
    const pl = await report('profit-loss', { ...MARCH, compareFrom: '2023-02-01', compareTo: '2023-02-28' });
    const s = Object.fromEntries(pl.sections.map((x) => [x.key, x]));
    expect(amountOf(s.revenue, '4100')).toBe(5000);
    expect(amountOf(s.cogs, '5100')).toBe(2000);
    expect(amountOf(s.expenses, '5220')).toBe(1000);
    expect(pl.grossProfit).toEqual({ amount: '3000.0000', compare: '0.0000' });
    expect(pl.netProfit).toEqual({ amount: '2000.0000', compare: '0.0000' });
  });

  it('trial balance balances and shows the period movements', async () => {
    const tb = await report('trial-balance', MARCH);
    expect(tb.balanced).toBe(true);
    const bank = tb.rows.find((r) => r.code === '1120');
    expect(bank).toMatchObject({
      opening: '0.0000',
      debit: '130000.0000',
      credit: '20000.0000',
      closing: '110000.0000',
    });
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });

  it('balance sheet: assets = liabilities + equity (with current earnings)', async () => {
    const bs = await report('balance-sheet', { asOf: '2023-03-31', compareAsOf: '2023-02-28' });
    expect(bs.balanced).toBe(true);
    const s = Object.fromEntries(bs.sections.map((x) => [x.key, x]));
    expect(amountOf(s.fixedAssets, '1210')).toBe(20000);
    expect(amountOf(s.longTermLiabilities, '2210')).toBe(30000);
    expect(s.equity.rows.find((r) => r.accountId === null).amount).toBe('2000.0000');
    expect(bs.totalAssets).toBe('132000.0000');
    expect(bs.totalLiabilitiesEquity).toBe('132000.0000');
    expect(bs.compareTotalAssets).toBe('0.0000');
  });

  it('cash flow ties to the change in cash and bank', async () => {
    const cf = await report('cash-flow', MARCH);
    expect(cf.balanced).toBe(true);
    const line = (section, key) => Number(cf[section].rows.find((r) => r.key === key)?.amount ?? 0);
    expect(line('operating', 'netProfit')).toBe(2000);
    expect(line('operating', 'inventory')).toBe(2000);
    expect(line('investing', 'fixedAssets')).toBe(-20000);
    expect(line('financing', 'loans')).toBe(30000);
    expect(line('financing', 'equity')).toBe(100000);
    expect(cf).toMatchObject({ netChange: '114000.0000', openingCash: '0.0000', closingCash: '114000.0000' });
  });

  it('general ledger runs the balance of an account', async () => {
    const gl = await report('general-ledger', { ...MARCH, accountId: acc['1120'].id });
    const [bank] = gl.accounts;
    expect(bank.rows.map((r) => r.balance)).toEqual(['100000.0000', '80000.0000', '110000.0000']);
    expect(bank).toMatchObject({ opening: '0.0000', closing: '110000.0000' });
    expect((await as(accountant).get(`${R}/general-ledger`, MARCH)).status).toBe(422);
  });

  it('day book lists every entry of the period', async () => {
    const book = await report('day-book', MARCH);
    expect(book.meta.total).toBe(6);
    expect(book.totalDebit).toBe('158000.0000');
    expect(book.entries.map((e) => e.narration)).toEqual([
      'Capital',
      'Cash sale',
      'Rent',
      'Cost of goods',
      'Furniture',
      'Bank loan',
    ]);
  });

  it('VAT: output from sales, input from expenses', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = await report('vat', { from: today, to: today });
    const bank = (await as(accountant).get(`${A}/bank-accounts/options`)).body.data[0];
    let category = (await as(accountant).get(`${A}/expense-categories`, { limit: 1 })).body.data[0];
    if (!category) {
      category = (
        await as(accountant).send('post', `${A}/expense-categories`, {
          name: 'Reports test',
          code: `RPT${Date.now() % 10000}`,
          accountId: acc['5260'].id,
        })
      ).body.data;
    }
    const expense = await as(accountant).send('post', `${A}/expenses`, {
      expenseDate: today,
      categoryId: category.id,
      bankAccountId: bank.id,
      amount: '400',
      taxAmount: '60',
      post: true,
    });
    expect(expense.status).toBe(201);
    const after = await report('vat', { from: today, to: today });
    expect(Number(after.input.tax) - Number(before.input.tax)).toBe(60);
    expect(Number(after.netPayable)).toBe(Number(after.output.tax) - Number(after.input.tax));
  }, 120_000);
});
