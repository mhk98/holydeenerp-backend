import { closeDatabase } from '../src/config/db.js';
import { StockBalance } from '../src/models.js';
import { stopBackupSchedule } from '../src/modules/backups/backups.scheduler.js';
import { api, bearer, login } from './helpers.js';

/** Manufacturing: work centers, BOMs (multi-level, versions) and the order lifecycle with stock and ledger. */

let admin;
let production;
let cashier;
let pcs;
let warehouseId;
const M = '/api/v1/manufacturing';

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
  if (![200, 201].includes(res.status))
    throw new Error(`${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

const product = (fields = {}) =>
  as(admin)
    .send('post', '/api/v1/products', {
      name: unique('MFG item'),
      type: 'raw_material',
      baseUnitId: pcs,
      purchasePrice: '10',
      salePrice: '0',
      ...fields,
    })
    .then((r) => ok(r, 'product'));

async function stockIn(productId, quantity, unitCost) {
  const created = await ok(
    await as(admin).send('post', '/api/v1/inventory/adjustments', {
      kind: 'adjustment',
      warehouseId,
      items: [{ productId, direction: 'in', quantity, unitCost }],
    }),
    'adjustment',
  );
  return ok(await as(admin).send('post', `/api/v1/inventory/adjustments/${created.id}/submit`), 'submit');
}

async function quantityOf(productId) {
  const b = await StockBalance.findOne({ where: { warehouseId, productId, variantId: null } });
  return b ? Number(b.quantity) : 0;
}

const step = (id, name, body) => as(production).send('post', `${M}/orders/${id}/${name}`, body);

/** Net debit − credit per account code over the journals of some sources. */
async function ledgerOf(sources) {
  const out = {};
  for (const [type, id] of sources) {
    const journals = (await as(admin).get(`/api/v1/accounting/journals/source/${type}/${id}`)).body.data;
    for (const j of journals)
      for (const l of j.lines)
        out[l.account.code] = Number(
          ((out[l.account.code] ?? 0) + Number(l.debit) - Number(l.credit)).toFixed(4),
        );
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

let wc;
let parts;

beforeAll(async () => {
  [admin, production, cashier] = await Promise.all([
    login('admin@holydeen.com'),
    login('production@holydeen.com'),
    login('cashier@holydeen.com'),
  ]);
  pcs = (await as(admin).get('/api/v1/products/lookups')).body.data.units.find((u) => u.code === 'pcs').id;
  warehouseId = (await as(admin).get('/api/v1/inventory/warehouses')).body.data.find(
    (w) => w.code === 'WH-TEJ',
  ).id;
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', {
    requireApproval: false,
    allowNegativeStock: false,
    costingMethod: 'weighted_average',
  });
  wc = await ok(
    await as(production).send('post', `${M}/work-centers`, {
      code: `T${Date.now() % 100000}`,
      name: unique('Assembly'),
      labourCostPerHour: '120',
      overheadCostPerHour: '60',
    }),
    'work center',
  );
  // Two raw materials in stock: 100 × 10 and 100 × 4.
  parts = [await product(), await product({ purchasePrice: '4' })];
  await stockIn(parts[0].id, '100', '10');
  await stockIn(parts[1].id, '100', '4');
}, 300_000);

afterAll(async () => {
  await as(admin).send('put', '/api/v1/settings/preferences/inventory', {
    requireApproval: true,
    allowNegativeStock: false,
    costingMethod: 'weighted_average',
  });
  stopBackupSchedule();
  await closeDatabase();
}, 120_000);

/** Active BOM: 1 output from 2 × part A (5% wastage) + 1 × part B, one 60-minute operation, one checkpoint. */
async function activeBom(output, extra = {}) {
  const bom = await ok(
    await as(production).send('post', `${M}/boms`, {
      code: `BOM-${Date.now() % 1_000_000}-${(seq += 1)}`,
      name: unique('BOM'),
      productId: output.id,
      quantity: '1',
      items: [
        { productId: parts[0].id, quantity: '2', wastagePercent: '5' },
        { productId: parts[1].id, quantity: '1' },
      ],
      operations: [{ name: 'Assemble', workCenterId: wc.id, setupMinutes: '0', runMinutes: '60' }],
      qualityChecks: [{ name: 'Final check' }],
      ...extra,
    }),
    'bom',
  );
  return ok(await as(production).send('post', `${M}/boms/${bom.id}/activate`, {}), 'activate');
}

describe('access and BOMs', () => {
  it('needs manufacturing permissions', async () => {
    expect((await as(cashier).get(`${M}/orders`)).status).toBe(403);
    expect((await as(production).get(`${M}/orders`)).status).toBe(200);
    expect((await as(production).send('delete', `${M}/work-centers/${wc.id}`)).status).toBe(403);
  });

  it('validates components and rolls up a multi-level standard cost', async () => {
    const sub = await product({ type: 'finished_good', name: unique('Sub-assembly') });
    const self = await as(production).send('post', `${M}/boms`, {
      code: `BOM-X${Date.now() % 100000}`,
      name: 'Self',
      productId: sub.id,
      quantity: '1',
      items: [{ productId: sub.id, quantity: '1' }],
    });
    expect(self.status).toBe(422);

    const subBom = await activeBom(sub);
    // Material 2 × 1.05 × 10 + 1 × 4 = 25; labour 1 h × 120; overhead 1 h × 60.
    expect(subBom.standardCost).toMatchObject({
      material: '25.0000',
      labour: '120.0000',
      overhead: '60.0000',
    });

    const top = await product({ type: 'finished_good', name: unique('Top') });
    const topBom = await activeBom(top, {
      items: [
        { productId: sub.id, quantity: '2' },
        { productId: parts[1].id, quantity: '1' },
      ],
      operations: [],
      qualityChecks: [],
    });
    // Two sub-assemblies at their full standard cost (205 each) + part B (4).
    expect(
      Number(topBom.standardCost.material) +
        Number(topBom.standardCost.labour) +
        Number(topBom.standardCost.overhead),
    ).toBe(414);

    const tree = await ok(await as(production).get(`${M}/boms/${topBom.id}/tree`, { quantity: '3' }), 'tree');
    const node = tree.children.find((c) => c.productId === String(sub.id));
    expect(node).toMatchObject({ quantity: '6.0000', bomId: String(subBom.id) });
    expect(node.children.find((c) => c.productId === String(parts[0].id)).quantity).toBe('12.6000');

    // Active BOMs are read-only; a new version is a draft copy.
    expect(
      (await as(production).send('put', `${M}/boms/${subBom.id}`, { ...subBom, items: [] })).status,
    ).not.toBe(200);
    const v2 = await ok(await as(production).send('post', `${M}/boms/${subBom.id}/new-version`), 'version');
    expect(v2).toMatchObject({ version: 2, status: 'draft' });
  }, 300_000);
});

describe('manufacturing order lifecycle', () => {
  it('issues, applies labour, checks quality, receives at actual cost and closes the variance', async () => {
    const output = await product({ type: 'finished_good', name: unique('Widget') });
    const bom = await activeBom(output);
    const before = [await quantityOf(parts[0].id), await quantityOf(parts[1].id)];

    const mo = await ok(
      await as(production).send('post', `${M}/orders`, {
        productId: output.id,
        quantity: '10',
        rawWarehouseId: warehouseId,
      }),
      'order',
    );
    expect(mo).toMatchObject({ status: 'draft', bomId: String(bom.id) });
    expect(mo.materials.map((m) => m.requiredQuantity)).toEqual(['21.0000', '10.0000']);
    expect(mo.operations[0].plannedMinutes).toBe('600.00');
    expect(mo.stdMaterialCost).toBe('250.0000');

    // Not before confirmation.
    expect((await step(mo.id, 'issue', {})).status).toBe(409);
    await ok(await step(mo.id, 'confirm'), 'confirm');
    const issued = await ok(await step(mo.id, 'issue', {}), 'issue');
    expect(issued).toMatchObject({ status: 'material_issued', materialCost: '250.0000' });
    expect([await quantityOf(parts[0].id), await quantityOf(parts[1].id)]).toEqual([
      before[0] - 21,
      before[1] - 10,
    ]);

    // Return one unit of part A.
    const back = await ok(
      await step(mo.id, 'return', { lines: [{ materialId: issued.materials[0].id, quantity: '1' }] }),
      'return',
    );
    expect(back.materialCost).toBe('240.0000');

    await ok(await step(mo.id, 'start'), 'start');
    // QC needs every operation done.
    expect((await step(mo.id, 'submit', { producedQuantity: '10' })).status).toBe(409);
    const op = back.operations[0];
    const done = await ok(
      await as(production).send('post', `${M}/orders/${mo.id}/operations/${op.id}/finish`, {
        actualMinutes: '540',
      }),
      'finish',
    );
    expect(done).toMatchObject({ labourCost: '1080.0000', overheadCost: '540.0000' });

    await ok(await step(mo.id, 'submit', { producedQuantity: '10' }), 'submit');
    // Completing needs the BOM's checkpoint.
    expect((await step(mo.id, 'complete', {})).status).toBe(409);
    const checked = await ok(
      await step(mo.id, 'quality', {
        name: 'Final check',
        result: 'fail',
        failedQuantity: '2',
        action: 'scrap',
        reason: 'Cracked',
      }),
      'quality',
    );
    expect(checked.scrappedQuantity).toBe('2.0000');

    const completed = await ok(await step(mo.id, 'complete', {}), 'complete');
    // 240 + 1080 + 540 = 1860 for 10 made; the 8 good units take 8/10 of it.
    expect(completed).toMatchObject({
      status: 'completed',
      goodQuantity: '8.0000',
      outputCost: '1488.0000',
      unitCost: '186.0000',
    });
    expect(await quantityOf(output.id)).toBe(8);

    const closed = await ok(await step(mo.id, 'close'), 'close');
    expect(closed).toMatchObject({ status: 'closed', varianceCost: '372.0000' });

    // Ledger: WIP nets to zero; inventory +1488 − 240; labour & overhead applied −1620; variance 372.
    const ledger = await ledgerOf([['manufacturing_order', mo.id]]);
    expect(ledger['1168']).toBeUndefined();
    expect(ledger['5180']).toBe(-1620);
    expect(ledger['5175']).toBe(372);

    // Reopen reverses the variance; close again posts it once.
    await ok(await step(mo.id, 'reopen'), 'reopen');
    expect((await ledgerOf([['manufacturing_order', mo.id]]))['5175']).toBeUndefined();
    await ok(await step(mo.id, 'close'), 'close again');
    expect((await ledgerOf([['manufacturing_order', mo.id]]))['5175']).toBe(372);
  }, 600_000);

  it('sends failed units back for rework and refuses to cancel with material out', async () => {
    const output = await product({ type: 'finished_good', name: unique('Gadget') });
    await activeBom(output, { operations: [] });
    const mo = await ok(
      await as(production).send('post', `${M}/orders`, {
        productId: output.id,
        quantity: '4',
        rawWarehouseId: warehouseId,
      }),
      'order',
    );
    await ok(await step(mo.id, 'confirm'), 'confirm');
    const issued = await ok(await step(mo.id, 'issue', {}), 'issue');
    expect((await step(mo.id, 'cancel')).status).toBe(409);

    await ok(await step(mo.id, 'start'), 'start');
    await ok(await step(mo.id, 'submit', { producedQuantity: '4' }), 'submit');
    const rework = await ok(
      await step(mo.id, 'quality', {
        name: 'Final check',
        result: 'fail',
        failedQuantity: '1',
        action: 'rework',
      }),
      'rework',
    );
    expect(rework).toMatchObject({ status: 'in_progress', producedQuantity: '3.0000' });
    await ok(await step(mo.id, 'submit', { producedQuantity: '4' }), 'resubmit');
    await ok(await step(mo.id, 'quality', { name: 'Final check', result: 'pass' }), 'pass');
    const completed = await ok(await step(mo.id, 'complete', {}), 'complete');
    expect(completed).toMatchObject({ goodQuantity: '4.0000', outputCost: issued.materialCost });

    // A draft can be cancelled and deleted.
    const draft = await ok(
      await as(production).send('post', `${M}/orders`, {
        productId: output.id,
        quantity: '1',
        rawWarehouseId: warehouseId,
      }),
      'draft',
    );
    await ok(await step(draft.id, 'cancel'), 'cancel');
    expect((await as(admin).send('delete', `${M}/orders/${draft.id}`)).status).toBe(200);
  }, 600_000);

  it('refuses to issue more than is in stock', async () => {
    const output = await product({ type: 'finished_good', name: unique('Big') });
    await activeBom(output, { operations: [] });
    const mo = await ok(
      await as(production).send('post', `${M}/orders`, {
        productId: output.id,
        quantity: '100000',
        rawWarehouseId: warehouseId,
      }),
      'order',
    );
    await ok(await step(mo.id, 'confirm'), 'confirm');
    const res = await step(mo.id, 'issue', {});
    expect(res.status).toBe(422);
    expect((await as(production).get(`${M}/orders/${mo.id}`)).body.data.status).toBe('confirmed');
  }, 300_000);
});

describe('planning', () => {
  it('finds shortages, raises a draft requisition and counts it as supply', async () => {
    const scarce = await product({ name: unique('Scarce part'), purchasePrice: '7' });
    await stockIn(scarce.id, '5', '7');
    const output = await product({ type: 'finished_good', name: unique('Planned') });
    await activeBom(output, { items: [{ productId: scarce.id, quantity: '3' }], operations: [] });
    const mo = await ok(
      await as(production).send('post', `${M}/orders`, {
        productId: output.id,
        quantity: '4',
        rawWarehouseId: warehouseId,
      }),
      'order',
    );

    const plan = await ok(await as(production).get(`${M}/mrp`, { orderId: mo.id }), 'mrp');
    const row = plan.rows.find((r) => r.productId === String(scarce.id));
    expect(row).toMatchObject({ demand: '12.0000', onHand: '5.0000', shortage: '7.0000', action: 'buy' });

    const req = await ok(
      await as(production).send('post', `${M}/mrp/requisition`, {
        warehouseId,
        lines: [{ productId: scarce.id, quantity: row.shortage }],
      }),
      'requisition',
    );
    expect(req.status).toBe('draft');
    const after = await ok(await as(production).get(`${M}/mrp`, { orderId: mo.id }), 'mrp again');
    expect(after.rows.find((r) => r.productId === String(scarce.id))).toMatchObject({
      requested: '7.0000',
      shortage: '0.0000',
    });

    // The order is on the schedule for its planned days.
    const day = mo.plannedStart;
    const schedule = await ok(await as(production).get(`${M}/schedule`, { from: day, to: day }), 'schedule');
    expect(schedule.some((o) => o.id === mo.id)).toBe(true);
  }, 300_000);

  it('reports completed orders, consumption and work-center load', async () => {
    const production_ = await ok(await as(production).get(`${M}/reports/production`), 'production report');
    expect(production_.rows.length).toBeGreaterThan(0);
    expect(production_.summary).toHaveProperty('yieldPercent');
    const consumption = await ok(await as(production).get(`${M}/reports/consumption`), 'consumption');
    expect(consumption.rows.some((r) => r.productId === String(parts[0].id))).toBe(true);
    const centers = await ok(await as(production).get(`${M}/reports/work-centers`), 'work centers');
    expect(centers.rows.find((r) => String(r.id) === String(wc.id))).toMatchObject({
      operations: expect.anything(),
    });
    expect((await as(production).get(`${M}/reports/nope`)).status).toBe(422);
  }, 300_000);
});
