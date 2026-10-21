'use strict';
/**
 * Accounting demo for Holydeen Trading Ltd.:
 *   · the standard chart of accounts and journals for every document already in the database
 *     (opening stock, purchases, sales, POS, … — the same backfill as `npm run accounting:backfill`)
 *   · the current fiscal year with monthly periods
 *   · a few manual journals: owner's capital into the bank, monthly rent, an electricity bill,
 *     and one draft (bank charges) waiting to be posted
 *   · cash & bank: cash in hand, BRAC and DBBL bank accounts, bKash; expense categories, two paid
 *     expenses and a cash deposit into the bank
 * Other companies only get their chart and backfill. Each part is added once.
 *
 * Runs the app's ES modules (the posting rules live there); the manufacturing demo seeder, which
 * runs after it, closes their connection.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COMPANY = 'HOLYDEEN';
const load = (rel) => import(pathToFileURL(path.join(__dirname, rel)).href);
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * Cash & bank demo (once per company): money accounts on the standard ledgers plus a second bank,
 * expense categories, two paid expenses and a cash deposit into the bank.
 */
async function seedCashAndBank(db, ctx, acc, today) {
  const [[existing]] = await db.query('SELECT COUNT(*) AS n FROM bank_accounts WHERE company_id = ?', {
    replacements: [ctx.auth.companyId],
  });
  if (Number(existing.n)) return;
  const { bankAccounts } = await load('../modules/accounting/bank-accounts.service.js');
  const { expenseCategories, createExpense } = await load('../modules/accounting/expenses.service.js');
  const { createVoucher } = await load('../modules/accounting/vouchers.service.js');

  const cash = await bankAccounts.create(ctx, {
    kind: 'cash',
    name: 'Cash in Hand — Head Office',
    accountId: acc['1110'],
    branchId: ctx.branchId,
  });
  const brac = await bankAccounts.create(ctx, {
    kind: 'bank',
    name: 'BRAC Bank — Current A/C',
    accountId: acc['1120'],
    bankName: 'BRAC Bank PLC',
    branchName: 'Gulshan',
    accountNumber: '1501-2045-6789-001',
    routingNumber: '060261726',
  });
  await bankAccounts.create(ctx, {
    kind: 'bank',
    name: 'Dutch-Bangla Bank — Current A/C',
    bankName: 'Dutch-Bangla Bank PLC',
    branchName: 'Motijheel',
    accountNumber: '101-110-0045566',
  });
  await bankAccounts.create(ctx, { kind: 'mobile_wallet', name: 'bKash Merchant', accountId: acc['1130'] });

  const categories = {};
  for (const [code, name, account] of [
    ['OFFICE', 'Office supplies & stationery', '5260'],
    ['UTILITY', 'Utilities', '5230'],
    ['TRANSPORT', 'Transport & conveyance', '5250'],
    ['REPAIR', 'Repairs & maintenance', '5270'],
    ['MARKETING', 'Marketing & advertising', '5280'],
    ['MISC', 'Miscellaneous', '5299'],
  ]) {
    categories[code] = await expenseCategories.create(ctx, { code, name, accountId: acc[account] });
  }

  await createVoucher(ctx, {
    voucherType: 'contra',
    voucherDate: today,
    bankAccountId: cash.id,
    toBankAccountId: brac.id,
    amount: '150000',
    reference: 'DEP-SLIP-2210',
    narration: 'Cash sales deposited to BRAC Bank',
    post: true,
  });
  await createExpense(ctx, {
    expenseDate: today,
    categoryId: categories.OFFICE.id,
    bankAccountId: cash.id,
    amount: '2400',
    taxAmount: '360',
    payee: 'Bashundhara Paper Mills outlet',
    reference: 'BP-55821',
    description: 'A4 paper, toner and files',
    post: true,
  });
  await createExpense(ctx, {
    expenseDate: today,
    categoryId: categories.TRANSPORT.id,
    bankAccountId: cash.id,
    amount: '1350',
    payee: 'Pathao Courier',
    description: 'Document delivery to Chattogram branch',
    post: true,
  });
}

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const { backfillCompany } = await load('../modules/accounting/backfill.service.js');
    const { createFiscalYear } = await load('../modules/accounting/fiscal.service.js');
    const { createJournal } = await load('../modules/accounting/journals.service.js');
    const { getSettings } = await load('../modules/settings/settings.service.js');

    const [companies] = await db.query('SELECT id, code FROM companies WHERE deleted_at IS NULL');
    for (const company of companies) {
      const [[user]] = await db.query(
        `SELECT id FROM users WHERE company_id = ?
          ORDER BY email = 'accountant@holydeen.com' DESC, id LIMIT 1`,
        { replacements: [company.id] },
      );
      const userId = user ? String(user.id) : null;
      await backfillCompany(company.id, { userId });
      if (company.code !== COMPANY) continue;

      const [[branch]] = await db.query("SELECT id FROM branches WHERE company_id = ? AND code = 'HO'", {
        replacements: [company.id],
      });
      const branchId = branch ? String(branch.id) : null;
      const ctx = {
        auth: { companyId: String(company.id), userId, isSuperAdmin: true, branchIds: [branchId] },
        branchId,
        branchIds: [branchId],
      };

      // Current fiscal year (Settings → Financial: July–June by default).
      const { fiscalYearStartMonth: month, fiscalYearStartDay: day } = await getSettings(
        company.id,
        'financial',
      );
      const today = new Date();
      let start = new Date(Date.UTC(today.getUTCFullYear(), month - 1, day));
      if (start > today) start = new Date(Date.UTC(today.getUTCFullYear() - 1, month - 1, day));
      const [[year]] = await db.query('SELECT id FROM fiscal_years WHERE company_id = ? AND start_date = ?', {
        replacements: [company.id, iso(start)],
      });
      if (!year) await createFiscalYear(ctx, { startDate: iso(start) });

      const [accounts] = await db.query('SELECT id, code FROM accounts WHERE company_id = ?', {
        replacements: [company.id],
      });
      const acc = Object.fromEntries(accounts.map((a) => [a.code, String(a.id)]));
      await seedCashAndBank(db, ctx, acc, iso(today));

      const [[manual]] = await db.query(
        "SELECT COUNT(*) AS n FROM journal_entries WHERE company_id = ? AND entry_type = 'manual'",
        { replacements: [company.id] },
      );
      if (Number(manual.n)) continue;
      const monthStart = (offset) =>
        iso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)));
      const months = Math.min(
        2,
        (today.getUTCFullYear() - start.getUTCFullYear()) * 12 + today.getUTCMonth() - start.getUTCMonth(),
      );
      const journal = (entryDate, narration, reference, debit, credit, amount, post = true) =>
        createJournal(ctx, {
          entryDate,
          branchId,
          narration,
          reference,
          post,
          lines: [
            { accountId: acc[debit], debit: amount, credit: '0' },
            { accountId: acc[credit], debit: '0', credit: amount },
          ],
        });

      await journal(
        iso(start),
        "Owner's capital deposited to the bank",
        'DEP-CAP-01',
        '1120',
        '3100',
        '5000000',
      );
      for (let m = 0; m <= months; m += 1) {
        await journal(
          monthStart(m),
          'Head office rent',
          `RENT-${monthStart(m).slice(0, 7)}`,
          '5220',
          '1120',
          '85000',
        );
      }
      await journal(monthStart(months), 'DESCO electricity bill', 'DESCO-0425', '5230', '1110', '18500');
      await journal(iso(today), 'Bank charges and SMS alert fee', null, '5285', '1120', '1150', false);
    }
  },

  async down(queryInterface) {
    for (const table of [
      'attachments',
      'expenses',
      'expense_categories',
      'bank_statement_lines',
      'bank_reconciliations',
      'cheques',
      'voucher_lines',
      'vouchers',
      'bank_accounts',
    ]) {
      await queryInterface.bulkDelete(table, null, {});
    }
    for (const table of ['journal_lines', 'journal_entries', 'fiscal_periods', 'fiscal_years']) {
      await queryInterface.bulkDelete(table, null, {});
    }
    await queryInterface.bulkUpdate('payment_methods', { account_id: null }, {});
    // Self-referencing tree: detach children before deleting.
    await queryInterface.bulkUpdate('accounts', { parent_id: null }, {});
    await queryInterface.bulkDelete('accounts', null, {});
  },
};
