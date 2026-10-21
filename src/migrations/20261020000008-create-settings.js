'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/**
 * settings: one JSON document per (company, group). company_id NULL holds system-wide groups
 * (e.g. backup schedule, which covers the whole database). Stored as TEXT for MariaDB/MySQL parity.
 * print_templates: invoice/receipt layouts for A4 and 80 mm thermal paper.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'settings',
      {
        ...idColumn(Sequelize),
        // RESTRICT: MariaDB forbids FK actions on columns used by generated columns (company_key).
        company_id: fk(Sequelize, 'companies', { allowNull: true }),
        group: { type: Sequelize.STRING(40), allowNull: false },
        value: { type: Sequelize.TEXT('medium'), allowNull: false },
        company_key: { type: 'BIGINT UNSIGNED AS (IFNULL(company_id, 0)) STORED' },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('settings', ['company_key', 'group'], {
      unique: true,
      name: 'settings_scope_group_unique',
    });

    await queryInterface.createTable(
      'print_templates',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        name: { type: Sequelize.STRING(100), allowNull: false },
        doc_type: { type: Sequelize.STRING(40), allowNull: false },
        paper: { type: Sequelize.ENUM('a4', 'thermal_80'), allowNull: false },
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        options: { type: Sequelize.TEXT, allowNull: false, comment: 'JSON layout options' },
        terms: { type: Sequelize.TEXT, allowNull: true },
        footer_note: { type: Sequelize.STRING(500), allowNull: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('print_templates', ['company_id', 'doc_type', 'paper']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('print_templates');
    await queryInterface.dropTable('settings');
  },
};
