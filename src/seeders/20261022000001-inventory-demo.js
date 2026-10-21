'use strict';
/**
 * Inventory demo for Holydeen Trading Ltd.:
 *  - number series for opening stock (OS-) and stock counts (SC-), added only where missing
 *  - one posted opening-stock document for the Tejgaon warehouse, written exactly as the stock
 *    engine would (movement + layer + balance per line), so stock, valuation, stock cards and
 *    alerts have data: a batch that expires soon and an item below its reorder level.
 */
const COMPANY = 'HOLYDEEN';
const WAREHOUSE = 'WH-TEJ';

// sku, quantity, unit cost, [batch no, expiry in days]
const LINES = [
  ['P-000001', '60', '365.0000', ['ACI-R-2610', 300]],
  ['P-000003', '30', '820.0000', ['TEER-A11', 20]],
  ['P-000003', '40', '830.0000', ['TEER-B07', 200]],
  ['P-000004', '96', '168.0000', ['RUP-0925', 9]],
  ['P-000006', '150', '125.0000', null],
  ['P-000007', '35', '105.0000', null],
  ['P-000011', '12', '0.0000', null],
];

const SERIES = [
  ['opening_stock', 'Opening stock', 'OS-{YYYY}-'],
  ['stock_count', 'Stock count', 'SC-{YYYY}-'],
  ['stock_transfer', 'Stock transfer', 'ST-{YYYY}-'],
  ['stock_adjustment', 'Stock adjustment', 'SA-{YYYY}-'],
];

const dateIn = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const money = (v) => Number(v).toFixed(4);

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const one = async (sql, replacements) => (await db.query(sql, { replacements }))[0][0];
    const company = await one('SELECT id FROM companies WHERE code = ?', [COMPANY]);
    if (!company) return;
    const now = new Date();
    const year = now.getFullYear();

    for (const [docType, name, prefix] of SERIES) {
      const exists = await one(
        'SELECT id FROM document_sequences WHERE company_id = ? AND doc_type = ? AND branch_id IS NULL',
        [company.id, docType],
      );
      if (exists) continue;
      await queryInterface.bulkInsert('document_sequences', [
        {
          company_id: company.id,
          branch_id: null,
          doc_type: docType,
          name,
          prefix,
          suffix: '',
          padding: 5,
          next_number: 1,
          reset_yearly: true,
          current_year: year,
          is_active: true,
          created_at: now,
          updated_at: now,
        },
      ]);
    }

    const warehouse = await one('SELECT id, branch_id FROM warehouses WHERE company_id = ? AND code = ?', [
      company.id,
      WAREHOUSE,
    ]);
    const user = await one('SELECT id FROM users WHERE email = ?', ['superadmin@holydeen.com']);
    if (!warehouse) return;
    const already = await one('SELECT id FROM stock_movements WHERE warehouse_id = ? LIMIT 1', [
      warehouse.id,
    ]);
    if (already) return;

    // Take a number from the opening-stock series.
    const seq = await one(
      'SELECT id, prefix, padding, next_number FROM document_sequences WHERE company_id = ? AND doc_type = ? AND branch_id IS NULL',
      [company.id, 'opening_stock'],
    );
    const number = `${seq.prefix.replace('{YYYY}', String(year))}${String(seq.next_number).padStart(seq.padding, '0')}`;
    await db.query(
      'UPDATE document_sequences SET next_number = next_number + 1, current_year = ? WHERE id = ?',
      { replacements: [year, seq.id] },
    );

    const today = dateIn(0);
    const audit = {
      created_by: user?.id ?? null,
      updated_by: user?.id ?? null,
      created_at: now,
      updated_at: now,
    };
    await queryInterface.bulkInsert('stock_adjustments', [
      {
        company_id: company.id,
        branch_id: warehouse.branch_id,
        warehouse_id: warehouse.id,
        number,
        kind: 'opening',
        adjustment_date: today,
        reason: 'opening_balance',
        status: 'posted',
        notes: 'Demo opening stock',
        total_value: '0',
        submitted_by: user?.id ?? null,
        submitted_at: now,
        approved_by: user?.id ?? null,
        approved_at: now,
        ...audit,
      },
    ]);
    const adjustment = await one('SELECT id FROM stock_adjustments WHERE company_id = ? AND number = ?', [
      company.id,
      number,
    ]);

    const running = new Map();
    let total = 0;
    for (const [i, [sku, qty, cost, batch]] of LINES.entries()) {
      const product = await one(
        'SELECT id, base_unit_id, purchase_price FROM products WHERE company_id = ? AND sku = ? AND deleted_at IS NULL',
        [company.id, sku],
      );
      if (!product) continue;
      const unitCost = Number(cost) > 0 ? money(cost) : money(product.purchase_price);
      const value = money(Number(qty) * Number(unitCost));
      let batchId = null;
      if (batch) {
        await queryInterface.bulkInsert('stock_batches', [
          {
            company_id: company.id,
            product_id: product.id,
            variant_id: null,
            batch_no: batch[0],
            expiry_date: dateIn(batch[1]),
            created_by: user?.id ?? null,
            created_at: now,
            updated_at: now,
          },
        ]);
        batchId = (
          await one('SELECT id FROM stock_batches WHERE company_id = ? AND product_id = ? AND batch_no = ?', [
            company.id,
            product.id,
            batch[0],
          ])
        ).id;
      }
      await queryInterface.bulkInsert('stock_adjustment_items', [
        {
          adjustment_id: adjustment.id,
          product_id: product.id,
          direction: 'in',
          batch_id: batchId,
          expiry_date: batch ? dateIn(batch[1]) : null,
          unit_id: product.base_unit_id,
          unit_factor: '1',
          quantity: money(qty),
          base_quantity: money(qty),
          unit_cost: unitCost,
          total_cost: value,
          reason: 'opening_balance',
          sort_order: i,
          created_at: now,
          updated_at: now,
        },
      ]);
      const item = await one('SELECT MAX(id) AS id FROM stock_adjustment_items WHERE adjustment_id = ?', [
        adjustment.id,
      ]);

      const before = running.get(product.id) ?? { qty: 0, value: 0 };
      const after = { qty: before.qty + Number(qty), value: before.value + Number(value) };
      running.set(product.id, after);
      total += Number(value);

      await queryInterface.bulkInsert('stock_movements', [
        {
          company_id: company.id,
          branch_id: warehouse.branch_id,
          warehouse_id: warehouse.id,
          product_id: product.id,
          batch_id: batchId,
          movement_type: 'opening',
          movement_date: today,
          reference_type: 'stock_adjustment',
          reference_id: adjustment.id,
          reference_no: number,
          reference_item_id: item.id,
          quantity: money(qty),
          unit_cost: unitCost,
          total_cost: value,
          balance_quantity: money(after.qty),
          balance_value: money(after.value),
          notes: 'Reason: opening_balance',
          created_by: user?.id ?? null,
          created_at: now,
        },
      ]);
      const movement = await one(
        'SELECT MAX(id) AS id FROM stock_movements WHERE reference_type = ? AND reference_id = ?',
        ['stock_adjustment', adjustment.id],
      );
      await queryInterface.bulkInsert('stock_layers', [
        {
          company_id: company.id,
          warehouse_id: warehouse.id,
          product_id: product.id,
          batch_id: batchId,
          movement_id: movement.id,
          received_at: now,
          quantity: money(qty),
          remaining: money(qty),
          unit_cost: unitCost,
          created_at: now,
          updated_at: now,
        },
      ]);
    }

    for (const [productId, { qty, value }] of running) {
      await queryInterface.bulkInsert('stock_balances', [
        {
          company_id: company.id,
          branch_id: warehouse.branch_id,
          warehouse_id: warehouse.id,
          product_id: productId,
          variant_id: null,
          quantity: money(qty),
          avg_cost: money(value / qty),
          total_value: money(value),
          last_movement_at: now,
          created_at: now,
          updated_at: now,
        },
      ]);
    }
    await db.query('UPDATE stock_adjustments SET total_value = ? WHERE id = ?', {
      replacements: [money(total), adjustment.id],
    });
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    for (const table of ['stock_movement_serials']) await db.query(`DELETE FROM ${table}`);
    for (const table of ['stock_count_items', 'stock_transfer_items', 'stock_adjustment_items'])
      await db.query(`DELETE FROM ${table}`);
    for (const table of [
      'stock_counts',
      'stock_transfers',
      'stock_adjustments',
      'stock_layers',
      'stock_balances',
      'stock_serials',
      'stock_movements',
      'stock_batches',
    ]) {
      await db.query(`DELETE FROM ${table} WHERE company_id = ?`, { replacements: [company.id] });
    }
    await db.query(
      "DELETE FROM document_sequences WHERE company_id = ? AND doc_type IN ('opening_stock', 'stock_count')",
      { replacements: [company.id] },
    );
  },
};
