// Shared column definitions for sequelize-cli migrations (CommonJS).
// Usage inside a migration:
//   const { idColumn, tenantColumns, auditColumns, money } = require('../utils/migration.cjs');
//   await queryInterface.createTable('items', {
//     ...idColumn(Sequelize),
//     ...tenantColumns(Sequelize),
//     name: { type: Sequelize.STRING(150), allowNull: false },
//     price: money(Sequelize),
//     ...auditColumns(Sequelize),
//   });

const idColumn = (Sequelize) => ({
  id: { type: Sequelize.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true, allowNull: false },
});

/** company_id (+ branch_id unless { branch: false }). Add FKs once companies/branches exist. */
const tenantColumns = (Sequelize, { branch = true } = {}) => ({
  company_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
  ...(branch && { branch_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true } }),
});

/** created_by, updated_by, created_at, updated_at, deleted_at (paranoid). */
const auditColumns = (Sequelize) => ({
  created_by: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
  updated_by: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
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
  deleted_at: { type: Sequelize.DATE, allowNull: true },
});

/** DECIMAL(18,4) — use for every money and quantity column. */
const money = (Sequelize, opts = {}) => ({
  type: Sequelize.DECIMAL(18, 4),
  allowNull: false,
  defaultValue: 0,
  ...opts,
});

/** Foreign key column: fk(Sequelize, 'branches', { allowNull: true, onDelete: 'SET NULL' }). */
const fk = (Sequelize, model, { allowNull = false, onDelete = 'RESTRICT' } = {}) => ({
  type: Sequelize.BIGINT.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onDelete,
});

/** company_id with a foreign key to companies (+ optional branch_id FK). */
const tenantRefs = (Sequelize, { branch = false, branchRequired = false } = {}) => ({
  company_id: fk(Sequelize, 'companies'),
  ...(branch && {
    branch_id: fk(Sequelize, 'branches', {
      allowNull: !branchRequired,
      onDelete: branchRequired ? 'RESTRICT' : 'SET NULL',
    }),
  }),
});

const tableOptions = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', engine: 'InnoDB' };

module.exports = {
  idColumn,
  tenantColumns,
  tenantRefs,
  fk,
  auditColumns,
  money,
  quantity: money,
  tableOptions,
};
