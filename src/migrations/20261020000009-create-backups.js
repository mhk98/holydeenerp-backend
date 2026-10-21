'use strict';

const { idColumn, fk, tableOptions } = require('../utils/migration.cjs');

/** Database backup files (whole database, so not tenant-scoped). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'backups',
      {
        ...idColumn(Sequelize),
        file_name: { type: Sequelize.STRING(200), allowNull: false, unique: true },
        size_bytes: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        type: { type: Sequelize.ENUM('manual', 'scheduled'), allowNull: false },
        status: {
          type: Sequelize.ENUM('running', 'completed', 'failed'),
          allowNull: false,
          defaultValue: 'running',
        },
        tables_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        rows_count: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        error: { type: Sequelize.STRING(1000), allowNull: true },
        created_by: fk(Sequelize, 'users', { allowNull: true, onDelete: 'SET NULL' }),
        completed_at: { type: Sequelize.DATE, allowNull: true },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      },
      tableOptions,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('backups');
  },
};
