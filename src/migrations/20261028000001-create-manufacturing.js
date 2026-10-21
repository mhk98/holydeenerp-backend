'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

const user = (Sequelize) => fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' });
const at = (Sequelize) => ({ type: Sequelize.DATE, allowNull: true });
const workflow = (Sequelize, ...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`${n}_by`, user(Sequelize)],
      [`${n}_at`, at(Sequelize)],
    ]),
  );
const timestamps = (Sequelize) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  updated_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
  },
});
const minutes = (Sequelize) => ({ type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 });
const percent = (Sequelize) => ({ type: Sequelize.DECIMAL(7, 4), allowNull: false, defaultValue: 0 });

/** Ledger accounts manufacturing posts to (also in the standard chart for new companies). */
const ACCOUNTS = [
  ['5175', 'Production Variance & Wastage', 'উৎপাদন পার্থক্য ও অপচয়', 'productionVariance'],
  ['5180', 'Production Labour & Overhead Applied', 'উৎপাদনে প্রযুক্ত শ্রম ও উপরিব্যয়', 'productionApplied'],
];

/**
 * Manufacturing: work centers, bills of materials (multi-level, versioned) with components, by-products,
 * routing operations and quality checkpoints, and manufacturing orders with their materials, operations,
 * outputs, scrap and quality checks.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const create = (name, columns) => queryInterface.createTable(name, columns, tableOptions);
    const product = () => ({
      product_id: fk(Sequelize, 'products'),
      variant_id: fk(Sequelize, 'product_variants', { allowNull: true }),
    });

    await create('work_centers', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true }),
      code: { type: Sequelize.STRING(30), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      capacity_hours: {
        type: Sequelize.DECIMAL(6, 2),
        allowNull: false,
        defaultValue: 8,
        comment: 'Per day',
      },
      labour_cost_per_hour: money(Sequelize),
      overhead_cost_per_hour: money(Sequelize),
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      notes: { type: Sequelize.STRING(500), allowNull: true },
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('work_centers', ['company_id', 'code'], {
      unique: true,
      name: 'work_centers_code_unique',
    });

    await create('boms', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize),
      ...product(),
      code: { type: Sequelize.STRING(40), allowNull: false },
      name: { type: Sequelize.STRING(150), allowNull: false },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      quantity: money(Sequelize, { comment: 'Output quantity (base unit) the components make' }),
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      ...workflow(Sequelize, 'activated'),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('boms', ['company_id', 'code'], { unique: true, name: 'boms_code_unique' });
    await queryInterface.addIndex('boms', ['company_id', 'product_id']);

    await create('bom_components', {
      ...idColumn(Sequelize),
      bom_id: fk(Sequelize, 'boms', { onDelete: 'CASCADE' }),
      ...product(),
      unit_id: fk(Sequelize, 'units', { allowNull: true }),
      unit_factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 1 },
      quantity: money(Sequelize),
      base_quantity: money(Sequelize),
      wastage_percent: percent(Sequelize),
      notes: { type: Sequelize.STRING(255), allowNull: true },
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('bom_components', ['bom_id']);

    await create('bom_byproducts', {
      ...idColumn(Sequelize),
      bom_id: fk(Sequelize, 'boms', { onDelete: 'CASCADE' }),
      ...product(),
      quantity: money(Sequelize, { comment: 'Base unit, per BOM output quantity' }),
      cost_share_percent: percent(Sequelize),
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(Sequelize),
    });

    await create('bom_operations', {
      ...idColumn(Sequelize),
      bom_id: fk(Sequelize, 'boms', { onDelete: 'CASCADE' }),
      sequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10 },
      name: { type: Sequelize.STRING(150), allowNull: false },
      work_center_id: fk(Sequelize, 'work_centers'),
      setup_minutes: minutes(Sequelize),
      run_minutes: minutes(Sequelize),
      notes: { type: Sequelize.STRING(255), allowNull: true },
      ...timestamps(Sequelize),
    });

    await create('bom_quality_checks', {
      ...idColumn(Sequelize),
      bom_id: fk(Sequelize, 'boms', { onDelete: 'CASCADE' }),
      sequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10 },
      name: { type: Sequelize.STRING(150), allowNull: false },
      instructions: { type: Sequelize.STRING(500), allowNull: true },
      ...timestamps(Sequelize),
    });

    await create('manufacturing_orders', {
      ...idColumn(Sequelize),
      ...tenantRefs(Sequelize, { branch: true, branchRequired: true }),
      number: { type: Sequelize.STRING(60), allowNull: false },
      ...product(),
      bom_id: fk(Sequelize, 'boms'),
      parent_id: fk(Sequelize, 'manufacturing_orders', { allowNull: true, onDelete: 'SET NULL' }),
      sales_order_id: fk(Sequelize, 'sales_orders', { allowNull: true, onDelete: 'SET NULL' }),
      sales_order_item_id: fk(Sequelize, 'sales_order_items', { allowNull: true, onDelete: 'SET NULL' }),
      raw_warehouse_id: fk(Sequelize, 'warehouses'),
      finished_warehouse_id: fk(Sequelize, 'warehouses'),
      quantity: money(Sequelize),
      produced_quantity: money(Sequelize),
      good_quantity: money(Sequelize, { comment: 'Produced − failed QC (scrapped)' }),
      scrapped_quantity: money(Sequelize),
      status: {
        type: Sequelize.ENUM(
          'draft',
          'confirmed',
          'material_issued',
          'in_progress',
          'quality_check',
          'completed',
          'closed',
          'cancelled',
        ),
        allowNull: false,
        defaultValue: 'draft',
      },
      priority: {
        type: Sequelize.ENUM('low', 'normal', 'high', 'urgent'),
        allowNull: false,
        defaultValue: 'normal',
      },
      planned_start: { type: Sequelize.DATEONLY, allowNull: false },
      planned_end: { type: Sequelize.DATEONLY, allowNull: false },
      actual_start: at(Sequelize),
      actual_end: at(Sequelize),
      std_material_cost: money(Sequelize),
      std_labour_cost: money(Sequelize),
      std_overhead_cost: money(Sequelize),
      material_cost: money(Sequelize, { comment: 'Issued − returned, at stock cost' }),
      labour_cost: money(Sequelize),
      overhead_cost: money(Sequelize),
      output_cost: money(Sequelize, { comment: 'Received into stock (finished goods + by-products)' }),
      variance_cost: money(Sequelize, { comment: 'Left in WIP at closing' }),
      unit_cost: money(Sequelize),
      notes: { type: Sequelize.TEXT, allowNull: true },
      ...workflow(Sequelize, 'confirmed', 'completed', 'closed', 'cancelled'),
      ...auditColumns(Sequelize),
    });
    await queryInterface.addIndex('manufacturing_orders', ['company_id', 'number'], {
      unique: true,
      name: 'manufacturing_orders_number_unique',
    });
    await queryInterface.addIndex('manufacturing_orders', ['company_id', 'status']);
    await queryInterface.addIndex('manufacturing_orders', ['company_id', 'planned_start']);

    const moChild = () => ({ order_id: fk(Sequelize, 'manufacturing_orders', { onDelete: 'CASCADE' }) });

    await create('mo_materials', {
      ...idColumn(Sequelize),
      ...moChild(),
      ...product(),
      required_quantity: money(Sequelize, { comment: 'Base unit, wastage included' }),
      issued_quantity: money(Sequelize),
      returned_quantity: money(Sequelize),
      cost: money(Sequelize, { comment: 'Net stock cost issued' }),
      sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('mo_materials', ['order_id']);

    await create('mo_operations', {
      ...idColumn(Sequelize),
      ...moChild(),
      sequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10 },
      name: { type: Sequelize.STRING(150), allowNull: false },
      work_center_id: fk(Sequelize, 'work_centers'),
      planned_minutes: minutes(Sequelize),
      actual_minutes: minutes(Sequelize),
      status: {
        type: Sequelize.ENUM('pending', 'in_progress', 'done'),
        allowNull: false,
        defaultValue: 'pending',
      },
      started_at: at(Sequelize),
      finished_at: at(Sequelize),
      labour_cost: money(Sequelize),
      overhead_cost: money(Sequelize),
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('mo_operations', ['order_id']);
    await queryInterface.addIndex('mo_operations', ['work_center_id']);

    await create('mo_outputs', {
      ...idColumn(Sequelize),
      ...moChild(),
      kind: { type: Sequelize.ENUM('product', 'byproduct'), allowNull: false },
      ...product(),
      warehouse_id: fk(Sequelize, 'warehouses'),
      batch_id: fk(Sequelize, 'stock_batches', { allowNull: true, onDelete: 'SET NULL' }),
      quantity: money(Sequelize),
      unit_cost: money(Sequelize),
      total_cost: money(Sequelize),
      output_date: { type: Sequelize.DATEONLY, allowNull: false },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('mo_outputs', ['order_id']);

    await create('mo_scrap', {
      ...idColumn(Sequelize),
      ...moChild(),
      ...product(),
      quantity: money(Sequelize),
      cost: money(Sequelize),
      reason: { type: Sequelize.STRING(255), allowNull: false },
      recorded_by: user(Sequelize),
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('mo_scrap', ['order_id']);

    await create('quality_checks', {
      ...idColumn(Sequelize),
      ...moChild(),
      name: { type: Sequelize.STRING(150), allowNull: false },
      result: { type: Sequelize.ENUM('pass', 'fail'), allowNull: false },
      passed_quantity: money(Sequelize),
      failed_quantity: money(Sequelize),
      action: { type: Sequelize.ENUM('accept', 'scrap', 'rework'), allowNull: false, defaultValue: 'accept' },
      reason: { type: Sequelize.STRING(500), allowNull: true },
      checked_by: user(Sequelize),
      checked_at: { type: Sequelize.DATE, allowNull: false },
      ...timestamps(Sequelize),
    });
    await queryInterface.addIndex('quality_checks', ['order_id']);

    // Companies whose chart already exists get the manufacturing accounts under Expenses (5000).
    const groups = await queryInterface.sequelize.query(
      "SELECT id, company_id AS companyId FROM accounts WHERE code = '5000' AND deleted_at IS NULL",
      { type: Sequelize.QueryTypes.SELECT },
    );
    for (const g of groups) {
      for (const [code, name, nameBn, key] of ACCOUNTS) {
        const [taken] = await queryInterface.sequelize.query(
          'SELECT COUNT(*) AS n FROM accounts WHERE company_id = :companyId AND (code = :code OR system_key = :key)',
          { replacements: { companyId: g.companyId, code, key }, type: Sequelize.QueryTypes.SELECT },
        );
        if (Number(taken.n)) continue;
        await queryInterface.bulkInsert('accounts', [
          {
            company_id: g.companyId,
            parent_id: g.id,
            code,
            name,
            name_bn: nameBn,
            type: 'expense',
            subtype: 'cogs',
            is_group: false,
            system_key: key,
            is_system: true,
            is_active: true,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ]);
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "DELETE a FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id WHERE a.system_key IN ('productionVariance', 'productionApplied') AND l.id IS NULL",
    );
    for (const table of [
      'quality_checks',
      'mo_scrap',
      'mo_outputs',
      'mo_operations',
      'mo_materials',
      'manufacturing_orders',
      'bom_quality_checks',
      'bom_operations',
      'bom_byproducts',
      'bom_components',
      'boms',
      'work_centers',
    ]) {
      await queryInterface.dropTable(table);
    }
  },
};
