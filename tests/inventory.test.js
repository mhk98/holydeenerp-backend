import { closeDatabase } from '../src/config/db.js';
import { StockBalance, StockMovement } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

let admin;
let manager;
let storekeeper;
let cashier;
let pcs;
const wh = {};

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
    name: `Inventory test item ${Date.now()}-${seq}`,
    type: 'finished_good',
    baseUnitId: pcs,
    purchasePrice: '100',
    salePrice: '150',
    reorderLevel: '5',
    ...fields,
  });
  if (res.status !== 201) throw new Error(`product create failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function setInventory(settings) {
  const res = await as(admin).send('put', '/api/v1/settings/preferences/inventory', settings);
  expect(res.status).toBe(200);
}

/** Create + submit an adjustment (approval off → posted). */
async function adjust(user, body) {
  const created = await as(user).send('post', '/api/v1/inventory/adjustments', {
    kind: 'adjustment',
    ...body,
  });
  if (created.status !== 201) return created;
  return as(user).send('post', `/api/v1/inventory/adjustments/${created.body.data.id}/submit`);
}

const stockIn = (warehouseId, productId, quantity, unitCost, extra = {}) =>
  adjust(admin, { warehouseId, items: [{ productId, direction: 'in', quantity, unitCost, ...extra }] });
const stockOut = (warehouseId, productId, quantity, extra = {}) =>
  adjust(admin, { warehouseId, items: [{ productId, direction: 'out', quantity, ...extra }] });

async function balanceOf(warehouseId, productId) {
  const b = await StockBalance.findOne({ where: { warehouseId, productId, variantId: null } });
  return b ? { quantity: b.quantity, avgCost: b.avgCost, totalValue: b.totalValue } : null;
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
  const warehouses = await as(admin).get('/api/v1/inventory/warehouses');
  for (const w of warehouses.body.data) wh[w.code] = w.id;
  await setInventory({
    requireApproval: false,
    allowNegativeStock: false,
    costingMethod: 'weighted_average',
  });
}, 180_000);

afterAll(async () => {
  await setInventory({ requireApproval: true, allowNegativeStock: false, costingMethod: 'weighted_average' });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

describe('access', () => {
  it('needs inventory permissions', async () => {
    expect((await as(cashier).get('/api/v1/inventory/stock')).status).toBe(403);
    expect((await as(storekeeper).get('/api/v1/inventory/stock')).status).toBe(200);
  });

  it('only shows warehouses of the user’s branches', async () => {
    const res = await as(storekeeper).get('/api/v1/inventory/warehouses');
    // Head-office warehouses only (other suites may add more to HO).
    const codes = res.body.data.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['WH-MTJ', 'WH-TEJ']));
    expect(codes).not.toEqual(expect.arrayContaining(['WH-AGR']));
    expect(codes).not.toContain('WH-SYL');
    const other = await as(storekeeper).get('/api/v1/inventory/stock', { warehouseId: wh['WH-AGR'] });
    expect(other.status).toBe(403);
  });
});

describe('demo opening stock', () => {
  it('is visible in the overview and the alerts', async () => {
    const stock = await as(admin).get('/api/v1/inventory/stock', {
      warehouseId: wh['WH-TEJ'],
      search: 'P-000006',
    });
    expect(stock.body.data[0]).toMatchObject({ sku: 'P-000006', quantity: '150.0000', status: 'in_stock' });
    const alerts = await as(admin).get('/api/v1/inventory/alerts');
    expect(alerts.status).toBe(200);
    expect(alerts.body.data.counts.nearExpiry).toBeGreaterThanOrEqual(2);
    expect(alerts.body.data.lowStock.map((r) => r.sku)).toEqual(
      expect.arrayContaining(['P-000007', 'P-000011']),
    );
  });
});

describe('costing', () => {
  it('weighted average: issues at the running average', async () => {
    const p = await newProduct();
    expect((await stockIn(wh['WH-MTJ'], p.id, '10', '100')).status).toBe(200);
    expect((await stockIn(wh['WH-MTJ'], p.id, '10', '200')).status).toBe(200);
    expect(await balanceOf(wh['WH-MTJ'], p.id)).toEqual({
      quantity: '20.0000',
      avgCost: '150.0000',
      totalValue: '3000.0000',
    });

    const out = await stockOut(wh['WH-MTJ'], p.id, '5');
    expect(out.status).toBe(200);
    expect(out.body.data.status).toBe('posted');
    expect(out.body.data.items[0]).toMatchObject({ unitCost: '150.0000', totalCost: '750.0000' });
    expect(await balanceOf(wh['WH-MTJ'], p.id)).toMatchObject({
      quantity: '15.0000',
      totalValue: '2250.0000',
    });
  });

  it('FIFO: issues from the oldest layers first', async () => {
    await setInventory({ costingMethod: 'fifo' });
    try {
      const p = await newProduct();
      await stockIn(wh['WH-MTJ'], p.id, '10', '100');
      await stockIn(wh['WH-MTJ'], p.id, '10', '200');
      const out = await stockOut(wh['WH-MTJ'], p.id, '12');
      // 10 × 100 + 2 × 200
      expect(out.body.data.items[0].totalCost).toBe('1400.0000');
      expect(await balanceOf(wh['WH-MTJ'], p.id)).toMatchObject({
        quantity: '8.0000',
        totalValue: '1600.0000',
      });
    } finally {
      await setInventory({ costingMethod: 'weighted_average' });
    }
  });

  it('emptying an item takes exactly the remaining value (no rounding residue)', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '3', '10');
    await stockIn(wh['WH-MTJ'], p.id, '3', '20');
    await stockOut(wh['WH-MTJ'], p.id, '1');
    await stockOut(wh['WH-MTJ'], p.id, '5');
    expect(await balanceOf(wh['WH-MTJ'], p.id)).toMatchObject({ quantity: '0.0000', totalValue: '0.0000' });
    const sum = await StockMovement.sum('totalCost', { where: { productId: p.id } });
    expect(Number(sum)).toBe(0);
  });

  it('converts pack quantities to the base unit', async () => {
    const lookups = await as(admin).get('/api/v1/products/lookups');
    const box = lookups.body.data.units.find((u) => u.code === 'box').id;
    const p = await newProduct({ units: [{ unitId: box, factor: '12' }] });
    const res = await stockIn(wh['WH-MTJ'], p.id, '2', '10', { unitId: box });
    expect(res.body.data.items[0]).toMatchObject({ quantity: '2.0000', baseQuantity: '24.0000' });
    expect((await balanceOf(wh['WH-MTJ'], p.id)).quantity).toBe('24.0000');
  });
});

describe('negative stock', () => {
  it('is refused unless enabled in settings', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '2', '50');
    const refused = await stockOut(wh['WH-MTJ'], p.id, '3');
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/Not enough stock/);

    await setInventory({ allowNegativeStock: true });
    try {
      expect((await stockOut(wh['WH-MTJ'], p.id, '3')).status).toBe(200);
      expect((await balanceOf(wh['WH-MTJ'], p.id)).quantity).toBe('-1.0000');
      // The next receipt first covers the shortfall.
      await stockIn(wh['WH-MTJ'], p.id, '5', '50');
      expect((await balanceOf(wh['WH-MTJ'], p.id)).quantity).toBe('4.0000');
    } finally {
      await setInventory({ allowNegativeStock: false });
    }
  });

  it('never oversells under concurrent postings (row locking)', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '10', '10');
    const drafts = await Promise.all(
      [1, 2, 3].map(() =>
        as(admin).send('post', '/api/v1/inventory/adjustments', {
          kind: 'adjustment',
          warehouseId: wh['WH-MTJ'],
          items: [{ productId: p.id, direction: 'out', quantity: '4' }],
        }),
      ),
    );
    // Submit the three posts concurrently: only two fit into 10.
    const results = await Promise.all(
      drafts.map((d) => as(admin).send('post', `/api/v1/inventory/adjustments/${d.body.data.id}/submit`)),
    );
    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(2);
    expect(results.filter((r) => r.status === 422)).toHaveLength(1);
    expect((await balanceOf(wh['WH-MTJ'], p.id)).quantity).toBe('2.0000');
  });
});

describe('approval workflow', () => {
  it('waits for inventory.approve when approval is required', async () => {
    await setInventory({ requireApproval: true });
    try {
      const p = await newProduct();
      const created = await as(storekeeper).send('post', '/api/v1/inventory/adjustments', {
        kind: 'opening',
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '7', unitCost: '40' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ status: 'draft', kind: 'opening' });
      expect(created.body.data.number).toMatch(/^OS-\d{4}-\d{5}$/);
      const id = created.body.data.id;

      const submitted = await as(storekeeper).send('post', `/api/v1/inventory/adjustments/${id}/submit`);
      expect(submitted.body.data.status).toBe('pending_approval');
      expect(await balanceOf(wh['WH-TEJ'], p.id)).toBeNull();

      expect((await as(storekeeper).send('post', `/api/v1/inventory/adjustments/${id}/approve`)).status).toBe(
        403,
      );
      const rejected = await as(manager).send('post', `/api/v1/inventory/adjustments/${id}/reject`, {
        reason: 'Wrong cost',
      });
      expect(rejected.body.data).toMatchObject({ status: 'rejected', rejectionReason: 'Wrong cost' });

      // Editing a rejected document returns it to draft.
      const edited = await as(storekeeper).send('put', `/api/v1/inventory/adjustments/${id}`, {
        kind: 'opening',
        warehouseId: wh['WH-TEJ'],
        items: [{ productId: p.id, quantity: '7', unitCost: '45' }],
      });
      expect(edited.body.data.status).toBe('draft');
      await as(storekeeper).send('post', `/api/v1/inventory/adjustments/${id}/submit`);
      const approved = await as(manager).send('post', `/api/v1/inventory/adjustments/${id}/approve`);
      expect(approved.body.data).toMatchObject({ status: 'posted', totalValue: '315.0000' });
      expect(approved.body.data.approver.name).toBeTruthy();
      expect(await balanceOf(wh['WH-TEJ'], p.id)).toMatchObject({
        quantity: '7.0000',
        totalValue: '315.0000',
      });

      // Posted documents are final.
      expect((await as(manager).send('post', `/api/v1/inventory/adjustments/${id}/approve`)).status).toBe(
        409,
      );
    } finally {
      await setInventory({ requireApproval: false });
    }
  });

  it('allows opening stock only before other movements of the item', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '1', '10');
    const res = await adjust(admin, {
      kind: 'opening',
      warehouseId: wh['WH-MTJ'],
      items: [{ productId: p.id, quantity: '5' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/already has stock movements/);
  });

  it('writes damage as a stock-out', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '10', '20');
    const res = await adjust(admin, {
      kind: 'damage',
      warehouseId: wh['WH-MTJ'],
      items: [{ productId: p.id, quantity: '3' }],
    });
    expect(res.body.data).toMatchObject({ status: 'posted', totalValue: '-60.0000', reason: 'damaged' });
    const ledger = await as(admin).get('/api/v1/inventory/movements', {
      productId: p.id,
      movementType: 'damage',
    });
    expect(ledger.body.data[0]).toMatchObject({ quantity: '-3.0000', totalCost: '-60.0000' });
  });
});

describe('transfers', () => {
  it('moves stock and value: draft → in transit → received', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-TEJ'], p.id, '10', '33.3333');
    const created = await as(admin).send('post', '/api/v1/inventory/transfers', {
      fromWarehouseId: wh['WH-TEJ'],
      toWarehouseId: wh['WH-AGR'],
      items: [{ productId: p.id, quantity: '4' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'draft' });
    expect(created.body.data.toBranch.code).toBe('CTG');
    const id = created.body.data.id;

    const dispatched = await as(admin).send('post', `/api/v1/inventory/transfers/${id}/dispatch`);
    expect(dispatched.body.data.status).toBe('in_transit');
    expect((await balanceOf(wh['WH-TEJ'], p.id)).quantity).toBe('6.0000');

    // The store keeper (HO only) cannot receive into Chattogram.
    expect((await as(storekeeper).send('post', `/api/v1/inventory/transfers/${id}/receive`)).status).toBe(
      403,
    );
    const received = await as(manager).send('post', `/api/v1/inventory/transfers/${id}/receive`);
    expect(received.body.data.status).toBe('received');

    const src = await balanceOf(wh['WH-TEJ'], p.id);
    const dst = await balanceOf(wh['WH-AGR'], p.id);
    expect(dst.quantity).toBe('4.0000');
    // Value is conserved exactly.
    expect((Number(src.totalValue) + Number(dst.totalValue)).toFixed(4)).toBe('333.3330');
  });

  it('cancelling a dispatched transfer returns the stock', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-TEJ'], p.id, '5', '10');
    const t = await as(admin).send('post', '/api/v1/inventory/transfers', {
      fromWarehouseId: wh['WH-TEJ'],
      toWarehouseId: wh['WH-MTJ'],
      items: [{ productId: p.id, quantity: '5' }],
    });
    await as(admin).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/dispatch`);
    expect(
      (await as(storekeeper).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/cancel`)).status,
    ).toBe(403);
    const cancelled = await as(manager).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/cancel`);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(await balanceOf(wh['WH-TEJ'], p.id)).toMatchObject({ quantity: '5.0000', totalValue: '50.0000' });
  });

  it('refuses to dispatch more than is on hand', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-TEJ'], p.id, '1', '10');
    const t = await as(admin).send('post', '/api/v1/inventory/transfers', {
      fromWarehouseId: wh['WH-TEJ'],
      toWarehouseId: wh['WH-MTJ'],
      items: [{ productId: p.id, quantity: '2' }],
    });
    expect(
      (await as(admin).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/dispatch`)).status,
    ).toBe(422);
  });
});

describe('batches and expiry', () => {
  it('tracks quantities per batch and requires a batch for batch items', async () => {
    const p = await newProduct({ trackBatch: true, trackExpiry: true });
    const noBatch = await stockIn(wh['WH-MTJ'], p.id, '5', '10');
    expect(noBatch.status).toBe(422);

    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    expect((await stockIn(wh['WH-MTJ'], p.id, '5', '10', { batchNo: 'A1', expiryDate: soon })).status).toBe(
      200,
    );
    expect((await stockIn(wh['WH-MTJ'], p.id, '8', '12', { batchNo: 'B1', expiryDate: later })).status).toBe(
      200,
    );

    const batches = await as(admin).get('/api/v1/inventory/batches', {
      productId: p.id,
      warehouseId: wh['WH-MTJ'],
      available: 'true',
    });
    expect(batches.body.data.map((b) => [b.batchNo, b.quantity])).toEqual([
      ['A1', '5.0000'],
      ['B1', '8.0000'],
    ]);

    const a1 = batches.body.data[0].id;
    expect((await stockOut(wh['WH-MTJ'], p.id, '6', { batchId: a1 })).status).toBe(422);
    expect((await stockOut(wh['WH-MTJ'], p.id, '2', { batchId: a1 })).status).toBe(200);

    const expiry = await as(admin).get('/api/v1/inventory/reports/expiry', {
      warehouseId: wh['WH-MTJ'],
      status: 'near',
    });
    expect(expiry.body.data.rows.find((r) => r.productId === p.id)).toMatchObject({
      batchNo: 'A1',
      quantity: '3.0000',
      status: 'near',
    });

    // A batch number keeps one expiry date.
    const clash = await stockIn(wh['WH-MTJ'], p.id, '1', '10', { batchNo: 'A1', expiryDate: later });
    expect(clash.status).toBe(422);
  }, 180_000);
});

describe('serial numbers', () => {
  it('tracks each unit through stock-in, transfer and stock-out', async () => {
    const p = await newProduct({ trackSerial: true });
    const wrongCount = await stockIn(wh['WH-TEJ'], p.id, '2', '1000', { serialNumbers: ['SN-1'] });
    expect(wrongCount.status).toBe(422);
    expect(
      (await stockIn(wh['WH-TEJ'], p.id, '2', '1000', { serialNumbers: [`${p.sku}-1`, `${p.sku}-2`] }))
        .status,
    ).toBe(200);
    expect((await stockIn(wh['WH-TEJ'], p.id, '1', '1000', { serialNumbers: [`${p.sku}-1`] })).status).toBe(
      422,
    );

    const t = await as(admin).send('post', '/api/v1/inventory/transfers', {
      fromWarehouseId: wh['WH-TEJ'],
      toWarehouseId: wh['WH-MTJ'],
      items: [{ productId: p.id, quantity: '1', serialNumbers: [`${p.sku}-2`] }],
    });
    await as(admin).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/dispatch`);
    const inTransit = await as(admin).get('/api/v1/inventory/serials', {
      productId: p.id,
      status: 'in_transit',
    });
    expect(inTransit.body.data.map((s) => s.serialNo)).toEqual([`${p.sku}-2`]);
    await as(admin).send('post', `/api/v1/inventory/transfers/${t.body.data.id}/receive`);

    // SN-2 is now in Motijheel, so it cannot leave Tejgaon.
    expect((await stockOut(wh['WH-TEJ'], p.id, '1', { serialNumbers: [`${p.sku}-2`] })).status).toBe(422);
    const scrapped = await adjust(admin, {
      kind: 'scrap',
      warehouseId: wh['WH-TEJ'],
      items: [{ productId: p.id, quantity: '1', serialNumbers: [`${p.sku}-1`] }],
    });
    expect(scrapped.status).toBe(200);
    const serials = await as(admin).get('/api/v1/inventory/serials', { productId: p.id });
    expect(Object.fromEntries(serials.body.data.map((s) => [s.serialNo, s.status]))).toEqual({
      [`${p.sku}-1`]: 'scrapped',
      [`${p.sku}-2`]: 'in_stock',
    });
  }, 180_000);
});

describe('stock counts', () => {
  it('generates a sheet and posts the variance', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '10', '20');

    const created = await as(storekeeper).send('post', '/api/v1/inventory/counts', {
      warehouseId: wh['WH-MTJ'],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('counting');
    const line = created.body.data.items.find((i) => i.productId === p.id);
    expect(line).toMatchObject({ systemQuantity: '10.0000', countedQuantity: null });

    // Only one open count per warehouse.
    expect(
      (await as(storekeeper).send('post', '/api/v1/inventory/counts', { warehouseId: wh['WH-MTJ'] })).status,
    ).toBe(409);

    const saved = await as(storekeeper).send(
      'put',
      `/api/v1/inventory/counts/${created.body.data.id}/items`,
      {
        items: [{ id: line.id, countedQuantity: '8' }],
      },
    );
    expect(saved.body.data.items.find((i) => i.id === line.id)).toMatchObject({
      varianceQuantity: '-2.0000',
    });

    const posted = await as(storekeeper).send(
      'post',
      `/api/v1/inventory/counts/${created.body.data.id}/submit`,
    );
    expect(posted.body.data).toMatchObject({ status: 'posted', varianceValue: '-40.0000' });
    expect((await balanceOf(wh['WH-MTJ'], p.id)).quantity).toBe('8.0000');
  });
});

describe('ledger', () => {
  it('stock card shows a running balance and period totals', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '10', '10');
    await stockOut(wh['WH-MTJ'], p.id, '4');
    await stockIn(wh['WH-MTJ'], p.id, '6', '10');
    const card = await as(admin).get(`/api/v1/inventory/products/${p.id}/card`);
    expect(card.status).toBe(200);
    expect(card.body.data.rows.map((r) => [r.quantity, r.runningQuantity])).toEqual([
      ['6.0000', '12.0000'],
      ['-4.0000', '6.0000'],
      ['10.0000', '10.0000'],
    ]);
    expect(card.body.data).toMatchObject({
      inQuantity: '16.0000',
      outQuantity: '4.0000',
      closing: { quantity: '12.0000' },
    });
    expect(card.body.meta.total).toBe(3);
  }, 180_000);

  it('is immutable', async () => {
    const m = await StockMovement.findOne();
    await expect(m.update({ quantity: '999' })).rejects.toThrow(/immutable/);
    await expect(StockMovement.destroy({ where: { id: m.id } })).rejects.toThrow(/immutable/);
  });

  it('blocks deleting a product with stock history', async () => {
    const p = await newProduct();
    await stockIn(wh['WH-MTJ'], p.id, '1', '1');
    expect((await as(admin).send('delete', `/api/v1/products/${p.id}`)).status).toBe(409);
  });
});

describe('item search', () => {
  it('finds by barcode scan and reports availability', async () => {
    const res = await as(admin).get('/api/v1/inventory/items/search', {
      q: '2000000000060',
      exact: 'true',
      warehouseId: wh['WH-TEJ'],
    });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ sku: 'P-000006', available: '150.0000' });
  });
});

describe('reports', () => {
  it.each([
    ['valuation', { groupBy: 'item' }],
    ['valuation', { groupBy: 'category' }],
    ['valuation', { groupBy: 'warehouse' }],
    ['slow-moving', { days: 1 }],
    ['abc', { basis: 'stock_value' }],
    ['abc', { basis: 'consumption' }],
    ['expiry', { status: 'all' }],
  ])('%s %o', async (report, query) => {
    const res = await as(manager).get(`/api/v1/inventory/reports/${report}`, query);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    expect(res.body.data.summary).toBeDefined();
  });

  it('ABC classes cover the whole value', async () => {
    const res = await as(admin).get('/api/v1/inventory/reports/abc', { basis: 'stock_value', limit: 500 });
    const { classes, totalValue } = res.body.data.summary;
    const sum = ['A', 'B', 'C'].reduce((s, k) => s + Number(classes[k].value), 0);
    expect(sum.toFixed(4)).toBe(Number(totalValue).toFixed(4));
    expect(res.body.data.rows[0].class).toBe('A');
  });

  it('summary totals per warehouse', async () => {
    const res = await as(admin).get('/api/v1/inventory/stock/summary');
    expect(res.body.data.warehouses.find((w) => w.code === 'WH-TEJ').itemsInStock).toBeGreaterThan(0);
  });
});
