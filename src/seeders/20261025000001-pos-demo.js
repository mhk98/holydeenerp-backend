'use strict';
/**
 * POS demo for Holydeen Trading Ltd.: a counter at each showroom / store (Motijheel showroom,
 * Agrabad, Zindabazar) selling from that warehouse, with the Walk-in Customer as default.
 * Registers that already exist are left alone.
 */
const COMPANY = 'HOLYDEEN';

const REGISTERS = [
  ['WH-MTJ', 'MTJ-01', 'Motijheel Counter 1', 'thermal_80'],
  ['WH-MTJ', 'MTJ-02', 'Motijheel Counter 2', 'thermal_80'],
  ['WH-AGR', 'AGR-01', 'Agrabad Counter', 'thermal_80'],
  ['WH-SYL', 'SYL-01', 'Zindabazar Counter', 'a4'],
];

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    const [[walkIn]] = await db.query(
      "SELECT id FROM parties WHERE company_id = ? AND is_customer = 1 AND name = 'Walk-in Customer' LIMIT 1",
      { replacements: [company.id] },
    );
    const now = new Date();
    for (const [warehouseCode, code, name, paper] of REGISTERS) {
      const [[warehouse]] = await db.query(
        'SELECT id, branch_id FROM warehouses WHERE company_id = ? AND code = ?',
        {
          replacements: [company.id, warehouseCode],
        },
      );
      if (!warehouse) continue;
      const [[exists]] = await db.query('SELECT id FROM pos_registers WHERE company_id = ? AND code = ?', {
        replacements: [company.id, code],
      });
      if (exists) continue;
      await queryInterface.bulkInsert('pos_registers', [
        {
          company_id: company.id,
          branch_id: warehouse.branch_id,
          warehouse_id: warehouse.id,
          name,
          code,
          default_customer_id: walkIn ? walkIn.id : null,
          receipt_paper: paper,
          is_active: true,
          created_at: now,
          updated_at: now,
        },
      ]);
    }
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    await db.query(
      `DELETE r FROM pos_registers r
        WHERE r.code IN (?) AND NOT EXISTS (SELECT 1 FROM pos_sessions s WHERE s.register_id = r.id)`,
      { replacements: [REGISTERS.map((r) => r[1])] },
    );
  },
};
