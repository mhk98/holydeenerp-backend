import { closeDatabase } from '../src/config/db.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

/** Cash & bank: money accounts, vouchers, expenses with files, cheques and bank reconciliation. */

let admin;
let accountant;
let storekeeper;
const acc = {};
const method = {};
let today;
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
const unique = (label) => `${label} ${Date.now() % 1_000_000}-${(seq += 1)}`;

async function ok(res, what) {
  if (![200, 201].includes(res.status)) throw new Error(`${what} failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
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

const newBank = (fields) =>
  as(accountant)
    .send('post', `${A}/bank-accounts`, { kind: 'bank', name: unique('Test bank'), ...fields })
    .then((r) => ok(r, 'bank account'));

const contra = (from, to, amount, date = today) =>
  as(accountant)
    .send('post', `${A}/vouchers`, {
      voucherType: 'contra',
      voucherDate: date,
      bankAccountId: from,
      toBankAccountId: to,
      amount,
      post: true,
    })
    .then((r) => ok(r, 'contra'));

beforeAll(async () => {
  [admin, accountant, storekeeper] = await Promise.all([
    login('admin@holydeen.com'),
    login('accountant@holydeen.com'),
    login('storekeeper@holydeen.com'),
  ]);
  for (const a of (await as(accountant).get(`${A}/accounts/options`)).body.data) acc[a.code] = a;
  for (const m of (await as(admin).get('/api/v1/purchase/lookups')).body.data.paymentMethods)
    method[m.code] = m;
  today = new Date().toISOString().slice(0, 10);
}, 180_000);

afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('money accounts', () => {
  it('needs accounting permissions', async () => {
    expect((await as(storekeeper).get(`${A}/bank-accounts`)).status).toBe(403);
    expect((await as(storekeeper).get(`${A}/vouchers`)).status).toBe(403);
  });

  it('creates a ledger next to the standard account, or links an existing one', async () => {
    const bank = await newBank({ bankName: 'Dutch-Bangla Bank', accountNumber: '101-110-4455' });
    expect(bank.account.code).toMatch(/^112[1-9]$|^1120-\d\d$/);
    expect(bank).toMatchObject({ balance: '0.0000', kind: 'bank' });
    const ledger =
      acc[bank.account.code] ?? (await as(accountant).get(`${A}/accounts/${bank.accountId}`)).body.data;
    expect(ledger).toMatchObject({ type: 'asset', subtype: 'bank' });

    const linked = await as(accountant).send('post', `${A}/bank-accounts`, {
      kind: 'bank',
      name: unique('Linked'),
      accountId: bank.accountId,
    });
    expect(linked.status).toBe(422);
    const wrong = await as(accountant).send('post', `${A}/bank-accounts`, {
      kind: 'cash',
      name: unique('Wrong'),
      accountId: acc['5220'].id,
    });
    expect(wrong.status).toBe(422);
  }, 120_000);
});

describe('vouchers', () => {
  let cash;
  let bank;

  beforeAll(async () => {
    cash = await newBank({ kind: 'cash', name: unique('Petty cash') });
    bank = await newBank({});
  }, 120_000);

  it('moves money between accounts with a contra voucher', async () => {
    const v = await contra(cash.id, bank.id, '10000');
    expect(v).toMatchObject({ status: 'posted', voucherType: 'contra', amount: '10000.0000' });
    expect(net(await journalsOf('voucher', v.id))).toEqual({
      [bank.account.code]: 10000,
      [cash.account.code]: -10000,
    });
    const balances = Object.fromEntries(
      (await as(accountant).get(`${A}/bank-accounts/options`)).body.data.map((b) => [b.id, b.balance]),
    );
    expect(balances[bank.id]).toBe('10000.0000');
  }, 120_000);

  it('pays from a bank account; receivables are not allowed on lines; void reverses', async () => {
    const ar = await as(accountant).send('post', `${A}/vouchers`, {
      voucherType: 'payment',
      voucherDate: today,
      bankAccountId: bank.id,
      lines: [{ accountId: acc['1150'].id, amount: '100' }],
    });
    expect(ar.status).toBe(422);

    const draft = await ok(
      await as(accountant).send('post', `${A}/vouchers`, {
        voucherType: 'payment',
        voucherDate: today,
        bankAccountId: bank.id,
        partyName: 'Rahim Properties',
        lines: [
          { accountId: acc['5220'].id, amount: '3000', description: 'Warehouse rent' },
          { accountId: acc['5230'].id, amount: '500', description: 'Electricity' },
        ],
      }),
      'payment',
    );
    expect(draft).toMatchObject({ status: 'draft', amount: '3500.0000' });
    expect(await journalsOf('voucher', draft.id)).toEqual([]);
    const posted = await ok(await as(accountant).send('post', `${A}/vouchers/${draft.id}/post`), 'post');
    expect(posted.status).toBe('posted');
    expect(net(await journalsOf('voucher', draft.id))).toEqual({
      5220: 3000,
      5230: 500,
      [bank.account.code]: -3500,
    });

    const voided = await ok(
      await as(accountant).send('post', `${A}/vouchers/${draft.id}/void`, { reason: 'Entered twice' }),
      'void',
    );
    expect(voided.status).toBe('void');
    expect(net(await journalsOf('voucher', draft.id))).toEqual({});
  }, 180_000);
});

describe('expenses', () => {
  it('posts the expense and its VAT, keeps the receipt file private, and voids', async () => {
    const bank = await newBank({});
    await contra((await newBank({ kind: 'cash', name: unique('Cash') })).id, bank.id, '1000');
    const category = await ok(
      await as(accountant).send('post', `${A}/expense-categories`, {
        name: unique('Stationery'),
        code: `ST${seq}${Date.now() % 1000}`,
        accountId: acc['5260'].id,
      }),
      'category',
    );
    const wrongCategory = await as(accountant).send('post', `${A}/expense-categories`, {
      name: unique('Bad'),
      code: `BD${seq}${Date.now() % 1000}`,
      accountId: acc['1110'].id,
    });
    expect(wrongCategory.status).toBe(422);

    const expense = await ok(
      await as(accountant).send('post', `${A}/expenses`, {
        expenseDate: today,
        categoryId: category.id,
        bankAccountId: bank.id,
        amount: '200',
        taxAmount: '30',
        payee: 'Paper House',
        reference: 'PH-778',
        post: true,
      }),
      'expense',
    );
    expect(expense).toMatchObject({ status: 'posted', total: '230.0000' });
    expect(net(await journalsOf('expense', expense.id))).toEqual({
      1170: 30,
      5260: 200,
      [bank.account.code]: -230,
    });

    const upload = await api()
      .post(`${A}/attachments/expense/${expense.id}`)
      .set(bearer(accountant.token))
      .attach('files', Buffer.from('%PDF-1.4\n% test receipt\n'), {
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
      });
    expect(upload.status).toBe(201);
    const [file] = upload.body.data;
    const bad = await api()
      .post(`${A}/attachments/expense/${expense.id}`)
      .set(bearer(accountant.token))
      .attach('files', Buffer.from('MZ'), { filename: 'virus.exe', contentType: 'application/octet-stream' });
    expect(bad.status).toBe(400);

    const withFiles = (await as(accountant).get(`${A}/expenses/${expense.id}`)).body.data;
    expect(withFiles.attachments.map((a) => a.originalName)).toEqual(['receipt.pdf']);
    const download = await as(accountant).get(`${A}/attachments/${file.id}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toMatch(/application\/pdf/);
    // Not reachable without signing in, nor through the public uploads folder.
    expect((await api().get(`${A}/attachments/${file.id}`)).status).toBe(401);
    expect((await api().get(`/uploads/attachments/${file.storedName}`)).status).toBe(404);
    expect((await as(storekeeper).get(`${A}/attachments/${file.id}`)).status).toBe(403);
    expect((await as(accountant).send('delete', `${A}/attachments/${file.id}`)).status).toBe(200);

    await ok(
      await as(accountant).send('post', `${A}/expenses/${expense.id}/void`, { reason: 'Wrong category' }),
      'void',
    );
    expect(net(await journalsOf('expense', expense.id))).toEqual({});
  }, 240_000);
});

describe('cheques', () => {
  let customer;
  let bank;

  beforeAll(async () => {
    customer = await ok(
      await as(admin).send('post', '/api/v1/customers', { name: unique('Cheque customer') }),
      'customer',
    );
    bank = await newBank({});
  }, 120_000);

  const receipt = (amount, reference) =>
    as(admin)
      .send('post', '/api/v1/sales/receipts', {
        customerId: customer.id,
        paymentMethodId: method.CHEQUE.id,
        amount,
        reference,
        allocations: [],
      })
      .then((r) => ok(r, 'receipt'));
  const chequeOf = async (sourceNo) =>
    (await as(accountant).get(`${A}/cheques`, { search: sourceNo })).body.data.find(
      (c) => c.sourceNo === sourceNo,
    );

  it('registers a received cheque in hand, clears it into the bank', async () => {
    const r = await receipt('5000', `CHQ-${Date.now() % 1_000_000}`);
    expect(net(await journalsOf('customer_receipt', r.id))).toEqual({ 1150: -5000, 1190: 5000 });
    const cheque = await chequeOf(r.number);
    expect(cheque).toMatchObject({
      direction: 'received',
      status: 'in_hand',
      amount: '5000.0000',
      chequeNo: r.reference,
    });

    const deposited = await ok(
      await as(accountant).send('post', `${A}/cheques/${cheque.id}/deposit`, { bankAccountId: bank.id }),
      'deposit',
    );
    expect(deposited.status).toBe('deposited');
    const cleared = await ok(
      await as(accountant).send('post', `${A}/cheques/${cheque.id}/clear`, {}),
      'clear',
    );
    expect(cleared.status).toBe('cleared');
    expect(net(await journalsOf('cheque', cheque.id))).toEqual({ 1190: -5000, [bank.account.code]: 5000 });
  }, 180_000);

  it('a bounced cheque voids its receipt, so the customer owes the money again', async () => {
    const r = await receipt('2500', `CHQ-${Date.now() % 1_000_000}`);
    const cheque = await chequeOf(r.number);
    await ok(
      await as(accountant).send('post', `${A}/cheques/${cheque.id}/deposit`, { bankAccountId: bank.id }),
      'deposit',
    );
    await ok(await as(accountant).send('post', `${A}/cheques/${cheque.id}/clear`, {}), 'clear');
    const bounced = await ok(
      await as(accountant).send('post', `${A}/cheques/${cheque.id}/bounce`, { reason: 'Insufficient funds' }),
      'bounce',
    );
    expect(bounced.status).toBe('bounced');
    expect((await as(admin).get(`/api/v1/sales/receipts/${r.id}`)).body.data.status).toBe('void');
    // Receipt and clearing both reversed: nothing left on AR, cheques in hand or the bank.
    expect(
      net([...(await journalsOf('customer_receipt', r.id)), ...(await journalsOf('cheque', cheque.id))]),
    ).toEqual({});
  }, 180_000);

  it('voiding the receipt by hand cancels an open cheque', async () => {
    const r = await receipt('700', `CHQ-${Date.now() % 1_000_000}`);
    await ok(
      await as(admin).send('post', `/api/v1/sales/receipts/${r.id}/void`, {
        reason: 'Customer took it back',
      }),
      'void',
    );
    expect((await chequeOf(r.number)).status).toBe('cancelled');
  }, 120_000);
});

describe('bank reconciliation', () => {
  it('imports a statement, matches, books bank charges and completes at zero difference', async () => {
    const bank = await newBank({ bankName: 'BRAC Bank' });
    const cash = await newBank({ kind: 'cash', name: unique('Vault') });
    const deposit = await contra(cash.id, bank.id, '20000');
    const payment = await ok(
      await as(accountant).send('post', `${A}/vouchers`, {
        voucherType: 'payment',
        voucherDate: today,
        bankAccountId: bank.id,
        reference: 'BP-RENT',
        lines: [{ accountId: acc['5220'].id, amount: '4000' }],
        post: true,
      }),
      'payment',
    );

    const rec = await ok(
      await as(accountant).send('post', `${A}/reconciliations`, {
        bankAccountId: bank.id,
        statementDate: today,
        statementBalance: '15950',
      }),
      'reconciliation',
    );
    expect(rec.summary).toMatchObject({
      openingBalance: '0.0000',
      difference: '15950.0000',
      ledgerBalance: '16000.0000',
    });
    expect(rec.ledgerLines).toHaveLength(2);

    const [d, m, y] = [today.slice(8, 10), today.slice(5, 7), today.slice(0, 4)];
    const csv = [
      'Date,Particulars,Ref,Withdrawal,Deposit,Balance',
      `${d}/${m}/${y},Cash deposit,${deposit.number},,"20,000.00",20000`,
      `${d}/${m}/${y},Cheque paid,BP-RENT,"4,000.00",,16000`,
      `${d}/${m}/${y},SMS & service charge,,50.00,,15950`,
    ].join('\n');
    const upload = (mapping) => {
      const req = api()
        .post(`${A}/reconciliations/${rec.id}/statement`)
        .set(bearer(accountant.token))
        .attach('file', Buffer.from(csv), { filename: 'statement.csv', contentType: 'text/csv' });
      return mapping ? req.field('mapping', JSON.stringify(mapping)) : req;
    };
    const preview = await ok(await upload(null), 'preview');
    expect(preview.preview[0]).toEqual(['Date', 'Particulars', 'Ref', 'Withdrawal', 'Deposit', 'Balance']);
    expect(preview.columns).toBe(6);

    const mapping = {
      headerRow: 1,
      date: 1,
      description: 2,
      reference: 3,
      debit: 4,
      credit: 5,
      dateFormat: 'DD/MM/YYYY',
    };
    const imported = await ok(await upload(mapping), 'import');
    expect(imported.imported).toBe(3);
    expect(imported.reconciliation.statementLines.map((l) => l.amount)).toEqual([
      '20000.0000',
      '-4000.0000',
      '-50.0000',
    ]);

    const auto = await ok(
      await as(accountant).send('post', `${A}/reconciliations/${rec.id}/auto-match`),
      'auto',
    );
    expect(auto.matched).toBe(2);
    expect(auto.reconciliation.summary.difference).toBe('-50.0000');
    expect((await as(accountant).send('post', `${A}/reconciliations/${rec.id}/complete`)).status).toBe(409);

    const charges = auto.reconciliation.statementLines.find((l) => !l.journalLineId);
    const booked = await ok(
      await as(accountant).send('post', `${A}/reconciliations/${rec.id}/statement/${charges.id}/book`, {
        accountId: acc['5285'].id,
      }),
      'book',
    );
    expect(booked.summary.difference).toBe('0.0000');
    const done = await ok(
      await as(accountant).send('post', `${A}/reconciliations/${rec.id}/complete`),
      'complete',
    );
    expect(done.status).toBe('completed');

    // The matched payment can no longer be voided; the account remembers the column mapping.
    expect(
      (await as(accountant).send('post', `${A}/vouchers/${payment.id}/void`, { reason: 'x' })).status,
    ).toBe(409);
    expect(
      (await as(accountant).get(`${A}/bank-accounts/${bank.id}`)).body.data.statementMapping,
    ).toMatchObject({
      dateFormat: 'DD/MM/YYYY',
    });
    const again = await as(accountant).send('post', `${A}/reconciliations`, {
      bankAccountId: bank.id,
      statementDate: today,
      statementBalance: '0',
    });
    expect(again.status).toBe(422);
  }, 300_000);

  it('keeps the ledger in balance', async () => {
    const r = (await as(accountant).get(`${A}/reconciliation`)).body.data;
    expect(r.trialBalance.balanced).toBe(true);
    expect(r.receivables.balanced).toBe(true);
    expect(r.payables.balanced).toBe(true);
  }, 120_000);
});
