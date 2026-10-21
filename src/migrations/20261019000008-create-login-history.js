'use strict';

const { idColumn, tableOptions } = require('../utils/migration.cjs');

/** Append-only log of every login attempt (successful or not). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'login_history',
      {
        ...idColumn(Sequelize),
        company_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: true,
          references: { model: 'companies', key: 'id' },
          onDelete: 'SET NULL',
        },
        user_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
        },
        email: { type: Sequelize.STRING(191), allowNull: false },
        ip: { type: Sequelize.STRING(45), allowNull: true },
        user_agent: { type: Sequelize.STRING(500), allowNull: true },
        device_name: { type: Sequelize.STRING(150), allowNull: true },
        success: { type: Sequelize.BOOLEAN, allowNull: false },
        failure_reason: { type: Sequelize.STRING(50), allowNull: true },
        created_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      },
      tableOptions,
    );
    await queryInterface.addIndex('login_history', ['user_id', 'created_at']);
    await queryInterface.addIndex('login_history', ['company_id', 'created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('login_history');
  },
};
