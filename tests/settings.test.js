import zlib from 'node:zlib';
import { sequelize, closeDatabase } from '../src/config/db.js';
import { DocumentSequence, Setting } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { convert } from '../src/modules/currencies/currencies.service.js';
import { nextNumber } from '../src/modules/sequences/sequences.service.js';
import { convertQuantity } from '../src/modules/units/units.service.js';
import { api, bearer, login } from './helpers.js';

let admin;
let superAdmin;
let manager;
let cashier;

beforeAll(async () => {
  [admin, superAdmin, manager, cashier] = await Promise.all([
    login('admin@holydeen.com'),
    login('superadmin@holydeen.com'),
    login('manager@holydeen.com'),
    login('cashier@holydeen.com'),
  ]);
});
afterAll(async () => {
  stopBackupSchedule();
  await closeDatabase();
});

const as = (user) => ({
  get: (u) => api().get(u).set(bearer(user.token)),
  send: (m, u, b) => api()[m](u).set(bearer(user.token)).send(b),
});
const branchIdOf = (user, code) => user.user.branches.find((b) => b.code === code).id;

describe('access', () => {
  it('lets any signed-in user read app config but not settings', async () => {
    const config = await as(cashier).get('/api/v1/settings/app-config');
    expect(config.status).toBe(200);
    expect(config.body.data).toMatchObject({
      baseCurrency: { code: 'BDT', symbol: '৳' },
      system: { timezone: 'Asia/Dhaka', dateFormat: 'DD/MM/YYYY' },
      financial: { fiscalYearStartMonth: 7, amountDecimals: 2 },
    });
    expect((await as(cashier).get('/api/v1/settings/company')).status).toBe(403);
    expect((await as(cashier).get('/api/v1/settings/units')).status).toBe(403);
  });
});

describe('company profile', () => {
  it('reads and updates the profile with validation', async () => {
    const get = await as(admin).get('/api/v1/settings/company');
    expect(get.body.data).toMatchObject({ code: 'HOLYDEEN', vatRegNo: '004567891-0101' });

    const bad = await as(admin).send('patch', '/api/v1/settings/company', {
      website: 'holydeen.com',
      name: '',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e) => e.field).sort()).toEqual(['name', 'website']);

    const ok = await as(admin).send('patch', '/api/v1/settings/company', {
      phone: '+8809612345679',
      tinNo: '111122223333',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ phone: '+8809612345679', tinNo: '111122223333' });
  });
});

describe('branches', () => {
  it('creates, moves the head office and protects it', async () => {
    const created = await as(admin).send('post', '/api/v1/settings/branches', {
      name: 'Khulna Branch',
      code: 'khl',
      phone: '+8804100000000',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('KHL');
    const { id } = created.body.data;

    expect(
      (await as(admin).send('post', '/api/v1/settings/branches', { name: 'Dup', code: 'KHL' })).status,
    ).toBe(409);

    await as(admin).send('patch', `/api/v1/settings/branches/${id}`, { isHeadOffice: true });
    const heads = await as(admin).get('/api/v1/settings/branches?isHeadOffice=true');
    expect(heads.body.data.map((b) => b.code)).toEqual(['KHL']);
    expect((await as(admin).send('delete', `/api/v1/settings/branches/${id}`)).status).toBe(400);

    // Hand the head office back to Dhaka, then the new branch can go.
    const ho = (await as(admin).get('/api/v1/settings/branches?search=HO')).body.data.find(
      (b) => b.code === 'HO',
    );
    await as(admin).send('patch', `/api/v1/settings/branches/${ho.id}`, { isHeadOffice: true });
    expect((await as(admin).send('delete', `/api/v1/settings/branches/${id}`)).status).toBe(200);
    // Code is free again after deletion.
    expect(
      (await as(admin).send('post', '/api/v1/settings/branches', { name: 'Khulna', code: 'KHL' })).status,
    ).toBe(201);
  });

  it('will not delete a branch that has users or warehouses', async () => {
    const ctg = (await as(admin).get('/api/v1/settings/branches')).body.data.find((b) => b.code === 'CTG');
    expect((await as(admin).send('delete', `/api/v1/settings/branches/${ctg.id}`)).status).toBe(409);
  });
});

describe('warehouses', () => {
  it('only shows warehouses of the user’s branches', async () => {
    const mine = await as(manager).get('/api/v1/settings/warehouses?limit=100');
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((w) => w.code).sort()).toEqual(['WH-AGR', 'WH-MTJ', 'WH-TEJ']);

    const all = await as(admin).get('/api/v1/settings/warehouses?limit=100');
    const sylhet = all.body.data.find((w) => w.code === 'WH-SYL');
    expect(sylhet.branch.code).toBe('SYL');
    // Not reachable by id or by filter for a user without the branch.
    expect((await as(manager).get(`/api/v1/settings/warehouses/${sylhet.id}`)).status).toBe(404);
    const filtered = await as(manager).get(`/api/v1/settings/warehouses?branchId=${sylhet.branchId}`);
    expect(filtered.body.data).toHaveLength(0);
  });

  it('narrows to the branch switcher selection', async () => {
    const res = await api()
      .get('/api/v1/settings/warehouses')
      .set(bearer(manager.token))
      .set('X-Branch-Id', branchIdOf(manager, 'CTG'));
    expect(res.body.data.map((w) => w.code)).toEqual(['WH-AGR']);
  });

  it('keeps one default per branch', async () => {
    const created = await as(admin).send('post', '/api/v1/settings/warehouses', {
      branchId: branchIdOf(admin, 'HO'),
      name: 'Savar Depot',
      code: 'wh-sav',
      isDefault: true,
    });
    expect(created.status).toBe(201);
    const defaults = (
      await as(admin).get(`/api/v1/settings/warehouses?branchId=${branchIdOf(admin, 'HO')}`)
    ).body.data.filter((w) => w.isDefault);
    expect(defaults.map((w) => w.code)).toEqual(['WH-SAV']);
  });

  it('rejects branches the user cannot access', async () => {
    const res = await as(manager).send('post', '/api/v1/settings/warehouses', {
      branchId: branchIdOf(admin, 'SYL'),
      name: 'Hidden',
      code: 'WH-X',
    });
    expect(res.status).toBe(403);
  });
});

describe('currencies and exchange rates', () => {
  it('lists currencies with their latest rate and protects the base', async () => {
    const res = await as(admin).get('/api/v1/settings/currencies?limit=50');
    const usd = res.body.data.find((c) => c.code === 'USD');
    const bdt = res.body.data.find((c) => c.code === 'BDT');
    expect(usd.latestRate.rate).toBe('122.500000');
    expect(bdt).toMatchObject({ isBase: true, latestRate: null });

    expect(
      (await as(admin).send('patch', `/api/v1/settings/currencies/${bdt.id}`, { isActive: false })).status,
    ).toBe(400);
    expect((await as(admin).send('delete', `/api/v1/settings/currencies/${bdt.id}`)).status).toBe(400);
    expect(
      (await as(admin).send('post', `/api/v1/settings/currencies/${bdt.id}/rates`, { rate: '2' })).status,
    ).toBe(400);
  });

  it('adds dated rates and converts through the base currency', async () => {
    const usd = (await as(admin).get('/api/v1/settings/currencies?search=USD')).body.data[0];
    const saved = await as(admin).send('post', `/api/v1/settings/currencies/${usd.id}/rates`, {
      rate: '123.000000',
      effectiveDate: '2099-01-01',
    });
    expect(saved.status).toBe(201);
    const history = await as(admin).get(`/api/v1/settings/currencies/${usd.id}/rates`);
    expect(history.body.data[0].effectiveDate).toBe('2099-01-01');
    // The future rate does not apply today.
    expect(await convert(admin.user.companyId, '100', 'USD', 'BDT')).toBe('12250.0000');
    expect(await convert(admin.user.companyId, '100', 'USD', 'BDT', '2099-06-01')).toBe('12300.0000');
    expect(await convert(admin.user.companyId, '1000', 'EUR', 'USD', undefined, 2)).toBe('1086.53');
    expect(
      (await as(admin).send('post', `/api/v1/settings/currencies/${usd.id}/rates`, { rate: '-1' })).status,
    ).toBe(422);
  });

  it('switches the base currency from financial settings', async () => {
    const toEur = await as(admin).send('put', '/api/v1/settings/preferences/financial', {
      baseCurrency: 'eur',
    });
    expect(toEur.status).toBe(200);
    expect(toEur.body.data.baseCurrency).toBe('EUR');
    const bases = (await as(admin).get('/api/v1/settings/currencies?isBase=true')).body.data;
    expect(bases.map((c) => c.code)).toEqual(['EUR']);

    expect(
      (await as(admin).send('put', '/api/v1/settings/preferences/financial', { baseCurrency: 'XYZ' })).status,
    ).toBe(422);
    await as(admin).send('put', '/api/v1/settings/preferences/financial', { baseCurrency: 'BDT' });
    expect((await as(admin).get('/api/v1/settings/app-config')).body.data.baseCurrency.code).toBe('BDT');
  });
});

describe('taxes', () => {
  it('reports the effective rate of compound groups', async () => {
    const groups = (await as(admin).get('/api/v1/settings/tax-groups?limit=50')).body.data;
    const sd = groups.find((g) => g.code === 'SD20VAT15');
    expect(sd.effectiveRate).toBe('38.0000');
    expect(sd.rates.map((r) => [r.code, r.isCompound])).toEqual([
      ['SD20', false],
      ['VAT15', true],
    ]);

    const calc = await as(admin).send('post', `/api/v1/settings/tax-groups/${sd.id}/calculate`, {
      amount: '1380',
      inclusive: true,
    });
    expect(calc.status).toBe(200);
    expect(calc.body.data).toMatchObject({ netAmount: '1000.00', totalTax: '380.00' });
  });

  it('creates groups in rate order and blocks deleting rates in use', async () => {
    const rates = (await as(admin).get('/api/v1/settings/tax-rates?limit=50')).body.data;
    const id = (code) => rates.find((r) => r.code === code).id;
    const created = await as(admin).send('post', '/api/v1/settings/tax-groups', {
      name: 'SD 30% + VAT 15%',
      code: 'sd30vat15',
      rates: [{ taxRateId: id('SD30') }, { taxRateId: id('VAT15'), isCompound: true }],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: 'SD30VAT15', effectiveRate: '49.5000' });

    expect((await as(admin).send('delete', `/api/v1/settings/tax-rates/${id('SD30')}`)).status).toBe(409);
    const dup = await as(admin).send('post', '/api/v1/settings/tax-groups', {
      name: 'Dup',
      code: 'DUP',
      rates: [{ taxRateId: id('VAT15') }, { taxRateId: id('VAT15') }],
    });
    expect(dup.status).toBe(422);
  });
});

describe('document numbering', () => {
  const take = (docType, branchId) =>
    sequelize.transaction((transaction) =>
      nextNumber({ companyId: admin.user.companyId, docType, branchId, transaction }),
    );

  it('numbers per branch with tokens and never hands out a number twice', async () => {
    const ho = branchIdOf(admin, 'HO');
    const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Dhaka', year: 'numeric' }).format(
      new Date(),
    );
    // Other test files may have numbered invoices already: check relative to the first number taken.
    const first = await take('sales_invoice', ho);
    expect(first).toMatch(new RegExp(`^INV-HO-${year}-\\d{5}$`));
    const start = Number(first.slice(-5));

    const parallel = await Promise.all(Array.from({ length: 8 }, () => take('sales_invoice', ho)));
    expect(new Set(parallel).size).toBe(8);
    expect(parallel.map((n) => Number(n.slice(-5))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_, i) => start + i + 1),
    );

    // Other branches have their own series.
    expect(await take('sales_invoice', branchIdOf(admin, 'CTG'))).toMatch(
      new RegExp(`^INV-CTG-${year}-\\d{5}$`),
    );
  });

  it('falls back to the company-wide series and resets on a new year', async () => {
    const year = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Dhaka', year: 'numeric' }).format(
      new Date(),
    );
    // A branch without its own series uses the company-wide one (numbers continue across both).
    const first = await take('quotation', branchIdOf(admin, 'HO'));
    expect(first).toMatch(new RegExp(`^QT-${year}-\\d{5}$`));
    const next = Number(first.slice(-5)) + 1;
    expect(await take('quotation', null)).toBe(`QT-${year}-${String(next).padStart(5, '0')}`);

    const where = { companyId: admin.user.companyId, docType: 'quotation' };
    const saved = (await DocumentSequence.findOne({ where })).toJSON();
    await DocumentSequence.update({ currentYear: Number(year) - 1, nextNumber: 500 }, { where });
    expect(await take('quotation', null)).toBe(`QT-${year}-00001`);
    // Put the series back so quotations created later don't reuse numbers.
    await DocumentSequence.update(
      { currentYear: saved.currentYear, nextNumber: saved.nextNumber },
      { where },
    );
  });

  it('previews without consuming and rejects duplicates', async () => {
    const list = (await as(admin).get('/api/v1/settings/document-sequences?docType=journal_entry')).body.data;
    const series = list[0];
    const p1 = await as(admin).get(`/api/v1/settings/document-sequences/${series.id}/preview`);
    const p2 = await as(admin).get(`/api/v1/settings/document-sequences/${series.id}/preview`);
    expect(p1.body.data.next).toBe(p2.body.data.next);

    const draft = await as(admin).send('post', '/api/v1/settings/document-sequences/preview', {
      prefix: 'GRN-{BRANCH}/',
      branchId: branchIdOf(admin, 'SYL'),
      padding: 3,
      nextNumber: 7,
    });
    expect(draft.body.data.next).toBe('GRN-SYL/007');

    const dup = await as(admin).send('post', '/api/v1/settings/document-sequences', {
      docType: 'journal_entry',
      name: 'Another',
    });
    expect(dup.status).toBe(409);
    const badToken = await as(admin).send('post', '/api/v1/settings/document-sequences', {
      docType: 'delivery_note',
      name: 'x',
      prefix: 'DN-{DAY}-',
    });
    expect(badToken.status).toBe(422);
  });
});

describe('units and conversions', () => {
  it('converts both ways and prevents duplicate pairs', async () => {
    const units = (await as(admin).get('/api/v1/settings/units?limit=100')).body.data;
    const id = (code) => units.find((u) => u.code === code).id;
    const company = admin.user.companyId;

    expect(await convertQuantity(company, '2', id('box'), id('pcs'))).toBe('24.0000');
    expect(await convertQuantity(company, '6', id('pcs'), id('box'))).toBe('0.5000');
    expect(await convertQuantity(company, '2', id('maund'), id('kg'), 3)).toBe('74.648');

    const inverse = await as(admin).send('post', '/api/v1/settings/unit-conversions', {
      fromUnitId: id('pcs'),
      toUnitId: id('box'),
      factor: '0.083333',
    });
    expect(inverse.status).toBe(409);
    const same = await as(admin).send('post', '/api/v1/settings/unit-conversions', {
      fromUnitId: id('kg'),
      toUnitId: id('kg'),
      factor: '1',
    });
    expect(same.status).toBe(422);

    const pack = await as(admin).send('post', '/api/v1/settings/unit-conversions', {
      fromUnitId: id('pack'),
      toUnitId: id('pcs'),
      factor: '6',
    });
    expect(pack.status).toBe(201);
    expect(pack.body.data).toMatchObject({
      factor: '6.000000',
      fromUnit: { code: 'pack' },
      toUnit: { code: 'pcs' },
    });
  });
});

describe('payment methods', () => {
  it('lists in display order and filters by type', async () => {
    const all = (await as(admin).get('/api/v1/settings/payment-methods')).body.data;
    expect(all[0].code).toBe('CASH');
    const wallets = (await as(admin).get('/api/v1/settings/payment-methods?type=mobile_wallet')).body.data;
    expect(wallets.map((w) => w.code).sort()).toEqual(['BKASH', 'NAGAD', 'ROCKET']);

    const upay = await as(admin).send('post', '/api/v1/settings/payment-methods', {
      name: 'Upay',
      code: 'upay',
      type: 'mobile_wallet',
      provider: 'UCB',
      requiresReference: true,
    });
    expect(upay.status).toBe(201);
    expect(upay.body.data.code).toBe('UPAY');
  });
});

describe('preferences', () => {
  it('returns defaults and validates strictly', async () => {
    const system = await as(admin).get('/api/v1/settings/preferences/system');
    expect(system.body.data).toMatchObject({ timezone: 'Asia/Dhaka', themeColor: 'neutral' });

    expect(
      (await as(admin).send('put', '/api/v1/settings/preferences/system', { timezone: 'Mars/Base' })).status,
    ).toBe(422);
    expect((await as(admin).send('put', '/api/v1/settings/preferences/system', { unknown: 1 })).status).toBe(
      422,
    );
    expect((await as(admin).get('/api/v1/settings/preferences/backup')).status).toBe(422);

    const saved = await as(admin).send('put', '/api/v1/settings/preferences/system', {
      dateFormat: 'DD MMM YYYY',
      themeColor: 'emerald',
    });
    expect(saved.body.data).toMatchObject({
      dateFormat: 'DD MMM YYYY',
      themeColor: 'emerald',
      timezone: 'Asia/Dhaka',
    });
  });

  it('stores the SMTP password encrypted and never returns it', async () => {
    const missingHost = await as(admin).send('put', '/api/v1/settings/preferences/smtp', { enabled: true });
    expect(missingHost.status).toBe(422);

    const saved = await as(admin).send('put', '/api/v1/settings/preferences/smtp', {
      enabled: false,
      host: '127.0.0.1',
      port: 1,
      username: 'erp@holydeen.com',
      password: 'super-secret-pass',
      fromEmail: 'erp@holydeen.com',
      fromName: 'Holydeen ERP',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ hasPassword: true, host: '127.0.0.1' });
    expect(saved.body.data.password).toBeUndefined();

    const row = await Setting.findOne({ where: { companyId: admin.user.companyId, group: 'smtp' } });
    expect(row.value).not.toContain('super-secret-pass');

    // Saving again without a password keeps the stored one.
    const again = await as(admin).send('put', '/api/v1/settings/preferences/smtp', { fromName: 'Holydeen' });
    expect(again.body.data.hasPassword).toBe(true);

    // Nothing listens on port 1, so the test email fails with a readable reason.
    const test = await as(admin).send('post', '/api/v1/settings/preferences/smtp/test', {
      to: 'me@holydeen.com',
    });
    expect(test.status).toBe(422);
    expect(test.body.message).toMatch(/SMTP test failed/);
  });
});

describe('print templates', () => {
  it('merges layout options with defaults and validates them', async () => {
    const list = (await as(admin).get('/api/v1/settings/print-templates?docType=invoice')).body.data;
    expect(list[0].options).toMatchObject({
      title: 'Tax Invoice',
      accentColor: '#0f766e',
      showMushakRef: true,
    });

    const bad = await as(admin).send('post', '/api/v1/settings/print-templates', {
      name: 'Bad',
      docType: 'invoice',
      paper: 'a4',
      options: { accentColor: 'red' },
    });
    expect(bad.status).toBe(422);

    const second = await as(admin).send('post', '/api/v1/settings/print-templates', {
      name: 'Minimal invoice',
      docType: 'invoice',
      paper: 'a4',
      isDefault: true,
      options: { showSignature: false },
    });
    expect(second.status).toBe(201);
    const defaults = (
      await as(admin).get('/api/v1/settings/print-templates?docType=invoice')
    ).body.data.filter((t) => t.isDefault);
    expect(defaults.map((t) => t.name)).toEqual(['Minimal invoice']);
  });
});

describe('backups', () => {
  it('is restricted to Super Admins', async () => {
    expect((await as(admin).get('/api/v1/settings/backups')).status).toBe(403);
    expect((await as(admin).send('post', '/api/v1/settings/backups')).status).toBe(403);
  });

  it('creates a downloadable gzipped SQL dump without generated columns', async () => {
    const created = await as(superAdmin).send('post', '/api/v1/settings/backups');
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'completed', type: 'manual', fileExists: true });
    expect(created.body.data.tablesCount).toBeGreaterThanOrEqual(20);

    const download = await api()
      .get(`/api/v1/settings/backups/${created.body.data.id}/download`)
      .set(bearer(superAdmin.token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    const sql = zlib.gunzipSync(download.body).toString('utf8');
    expect(sql).toMatch(/CREATE TABLE `users`/);
    expect(sql).toMatch(/INSERT INTO `users`/);
    expect(sql).not.toMatch(/INSERT INTO `document_sequences` \([^)]*branch_key/);

    expect(
      (await as(superAdmin).send('delete', `/api/v1/settings/backups/${created.body.data.id}`)).status,
    ).toBe(200);
  }, 180_000);

  it('saves the schedule', async () => {
    const saved = await as(superAdmin).send('put', '/api/v1/settings/backups/schedule', {
      scheduleEnabled: true,
      frequency: 'weekly',
      time: '03:15',
      weekday: 5,
      retention: 4,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.cron).toBe('15 3 * * 5');
    const off = await as(superAdmin).send('put', '/api/v1/settings/backups/schedule', {
      scheduleEnabled: false,
    });
    expect(off.body.data.cron).toBeNull();
  });
});
