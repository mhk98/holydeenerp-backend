'use strict';
/**
 * Manufacturing demo for Holydeen Trading Ltd. — Eid gift hampers assembled at the Tejgaon warehouse:
 *   · work centers: packing line, hamper assembly table, quality desk
 *   · products: the hamper (finished good) and its raw materials — bulk sugar, bulk masoor dal, 1 L oil
 *     bottles and a printed box — with opening stock (the trading stock used elsewhere is left alone)
 *   · an active BOM (oil, sugar, lentils, box; 2% box wastage) with a 3-step routing and a QC check
 *   · orders: one closed (made, checked, received at actual cost), one in progress (materials issued,
 *     first operation done) and one draft planned for next week
 * Added once per company. Runs the app's ES modules and closes their connection at the end, so keep
 * this the last seeder that needs the app's database layer.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const COMPANY = 'HOLYDEEN';
const WAREHOUSE = 'WH-TEJ';
const load = (rel) => import(pathToFileURL(path.join(__dirname, rel)).href);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (days) => iso(new Date(Date.now() + days * 86_400_000));

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const { closeDatabase } = await load('../config/db.js');
    try {
      const one = async (sql, replacements) => (await db.query(sql, { replacements }))[0][0];
      const company = await one('SELECT id FROM companies WHERE code = ? AND deleted_at IS NULL', [COMPANY]);
      if (!company) return;
      if (Number((await one('SELECT COUNT(*) AS n FROM boms WHERE company_id = ?', [company.id])).n)) return;
      const warehouse = await one('SELECT id, branch_id FROM warehouses WHERE company_id = ? AND code = ?', [
        company.id,
        WAREHOUSE,
      ]);
      if (!warehouse) return;
      const user = await one(
        `SELECT id FROM users WHERE company_id = ? ORDER BY email = 'admin@holydeen.com' DESC, id LIMIT 1`,
        [company.id],
      );
      const branchId = String(warehouse.branch_id);
      const ctx = {
        auth: {
          companyId: String(company.id),
          userId: String(user.id),
          isSuperAdmin: true,
          branchIds: [branchId],
        },
        branchId,
        branchIds: [branchId],
      };

      const { saveProduct } = await load('../modules/products/products.service.js');
      const adjustments = await load('../modules/inventory/adjustments.service.js');
      const boms = await load('../modules/manufacturing/bom.service.js');
      const orders = await load('../modules/manufacturing/orders.service.js');

      const unit = async (code) =>
        String((await one('SELECT id FROM units WHERE company_id = ? AND code = ?', [company.id, code])).id);
      const [pcs, kg] = [await unit('pcs'), await unit('kg')];

      // Products: the hamper and its own raw materials (the trading stock is left alone).
      const material = (name, baseUnitId, purchasePrice, reorderLevel) =>
        saveProduct(ctx, null, {
          name,
          type: 'raw_material',
          baseUnitId,
          purchasePrice,
          salePrice: '0',
          reorderLevel,
        });
      const sugar = await material('Bulk Refined Sugar (hamper stock)', kg, '118', '40');
      const dal = await material('Bulk Masoor Dal (hamper stock)', kg, '98', '40');
      const oil = await material('Soybean Oil 1 L Bottle (hamper stock)', pcs, '165', '40');
      const box = await material('Gift Hamper Box (printed)', pcs, '45', '50');
      const hamper = await saveProduct(ctx, null, {
        name: 'Holydeen Eid Gift Hamper — Classic',
        type: 'finished_good',
        baseUnitId: pcs,
        purchasePrice: '0',
        salePrice: '850',
      });

      // Opening stock of the raw materials
      const opening = await adjustments.createAdjustment(ctx, {
        kind: 'opening',
        warehouseId: String(warehouse.id),
        reason: 'opening_balance',
        notes: 'Hamper raw materials',
        items: [
          [sugar, '120', '118'],
          [dal, '120', '98'],
          [oil, '120', '165'],
          [box, '200', '45'],
        ].map(([p, quantity, unitCost]) => ({ productId: String(p.id), quantity, unitCost })),
      });
      await adjustments.submitAdjustment(ctx, opening.id);
      const pending = await one('SELECT status FROM stock_adjustments WHERE id = ?', [opening.id]);
      if (pending.status === 'pending_approval') await adjustments.approveAdjustment(ctx, opening.id);

      // Work centers
      const center = async (code, name, labour, overhead, notes) =>
        boms.workCenters.create(ctx, {
          code,
          name,
          branchId,
          capacityHours: '8',
          labourCostPerHour: labour,
          overheadCostPerHour: overhead,
          notes,
        });
      const pack = await center('PACK', 'Packing line', '150', '60', 'Two packers, heat sealer');
      const assembly = await center('ASSY', 'Hamper assembly table', '120', '40', 'Seasonal assembly team');
      const qc = await center('QC', 'Quality desk', '100', '20', null);

      // BOM
      const bom = await boms.createBom(ctx, {
        code: 'BOM-HAMPER',
        name: 'Eid Gift Hamper — Classic',
        productId: String(hamper.id),
        quantity: '1',
        notes: 'One hamper: soybean oil, sugar and masoor dal in a printed box.',
        items: [
          { productId: String(oil.id), quantity: '1' },
          { productId: String(sugar.id), quantity: '1' },
          { productId: String(dal.id), quantity: '1' },
          {
            productId: String(box.id),
            quantity: '1',
            wastagePercent: '2',
            notes: 'Some boxes tear while folding',
          },
        ],
        operations: [
          {
            name: 'Fold & prepare boxes',
            workCenterId: String(pack.id),
            setupMinutes: '15',
            runMinutes: '2',
          },
          { name: 'Assemble hamper', workCenterId: String(assembly.id), setupMinutes: '10', runMinutes: '5' },
          { name: 'Inspect & seal', workCenterId: String(qc.id), setupMinutes: '0', runMinutes: '1.5' },
        ],
        qualityChecks: [
          {
            name: 'Contents & seal check',
            instructions: 'Oil, sugar and dal present, box sealed, no dents.',
          },
        ],
      });
      await boms.activateBom(ctx, bom.id, { makeDefault: true });

      const [made, running] = [20, 30];

      const base = {
        productId: String(hamper.id),
        rawWarehouseId: String(warehouse.id),
        finishedWarehouseId: String(warehouse.id),
      };

      // 1. Closed: made, one failed QC and was scrapped.
      let mo = await orders.createOrder(ctx, {
        ...base,
        quantity: String(made),
        plannedStart: addDays(-6),
        priority: 'high',
      });
      await orders.confirmOrder(ctx, mo.id);
      await orders.issueMaterials(ctx, mo.id, { date: addDays(-6) });
      await orders.startOrder(ctx, mo.id);
      mo = await orders.getOrder(ctx, mo.id);
      for (const [i, op] of mo.operations.entries())
        await orders.finishOperation(ctx, mo.id, op.id, { actualMinutes: ['58', '110', '35'][i] });
      await orders.submitForQuality(ctx, mo.id, { producedQuantity: String(made) });
      await orders.recordQuality(ctx, mo.id, {
        name: 'Contents & seal check',
        result: 'fail',
        failedQuantity: '1',
        action: 'scrap',
        reason: 'Oil bottle leaked inside the box',
      });
      await orders.completeOrder(ctx, mo.id, { outputDate: addDays(-5) });
      await orders.closeOrder(ctx, mo.id);

      // 2. In progress: materials issued, boxes folded.
      mo = await orders.createOrder(ctx, {
        ...base,
        quantity: String(running),
        plannedStart: addDays(-1),
        notes: 'Corporate order',
      });
      await orders.confirmOrder(ctx, mo.id);
      await orders.issueMaterials(ctx, mo.id, {});
      await orders.startOrder(ctx, mo.id);
      mo = await orders.getOrder(ctx, mo.id);
      await orders.finishOperation(ctx, mo.id, mo.operations[0].id, { actualMinutes: '80' });

      // 3. Draft for next week.
      await orders.createOrder(ctx, {
        ...base,
        quantity: '50',
        plannedStart: addDays(7),
        priority: 'normal',
      });
    } finally {
      await closeDatabase();
    }
  },

  async down() {
    // Demo documents carry stock and ledger history; reset the database to remove them.
  },
};
