'use strict';

const { idColumn, tenantRefs, fk, auditColumns, tableOptions } = require('../utils/migration.cjs');

/**
 * Number series per document type and branch (branch_id NULL = company-wide fallback).
 * prefix/suffix accept tokens {BRANCH} {YYYY} {YY} {MM}; e.g. "INV-{BRANCH}-{YYYY}-" + 5 digits.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'document_sequences',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        // RESTRICT (not SET NULL): MariaDB forbids FK actions on columns used by generated columns.
        // Branches are soft-deleted, so this never blocks normal use.
        branch_id: fk(Sequelize, 'branches', { allowNull: true }),
        doc_type: { type: Sequelize.STRING(40), allowNull: false },
        name: { type: Sequelize.STRING(100), allowNull: false },
        prefix: { type: Sequelize.STRING(50), allowNull: false, defaultValue: '' },
        suffix: { type: Sequelize.STRING(50), allowNull: false, defaultValue: '' },
        padding: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false, defaultValue: 5 },
        next_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        reset_yearly: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        current_year: { type: Sequelize.SMALLINT.UNSIGNED, allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        // Generated so MariaDB/MySQL can enforce one series per (company, branch-or-company-wide, type).
        branch_key: {
          type: 'BIGINT UNSIGNED AS (IFNULL(branch_id, 0)) STORED',
        },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('document_sequences', ['company_id', 'branch_key', 'doc_type'], {
      unique: true,
      name: 'document_sequences_scope_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('document_sequences');
  },
};
