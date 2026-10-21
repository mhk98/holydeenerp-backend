'use strict';

const { idColumn, auditColumns, tableOptions } = require('../utils/migration.cjs');

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'users',
      {
        ...idColumn(Sequelize),
        company_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          references: { model: 'companies', key: 'id' },
          onDelete: 'RESTRICT',
        },
        name: { type: Sequelize.STRING(150), allowNull: false },
        email: { type: Sequelize.STRING(191), allowNull: false, unique: true },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        password_hash: { type: Sequelize.STRING(100), allowNull: false },
        avatar_url: { type: Sequelize.STRING(500), allowNull: true },
        status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
        language: { type: Sequelize.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },

        failed_login_attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        locked_until: { type: Sequelize.DATE, allowNull: true },
        last_login_at: { type: Sequelize.DATE, allowNull: true },
        last_login_ip: { type: Sequelize.STRING(45), allowNull: true },
        password_changed_at: { type: Sequelize.DATE, allowNull: true },
        password_reset_token_hash: { type: Sequelize.CHAR(64), allowNull: true, unique: true },
        password_reset_expires_at: { type: Sequelize.DATE, allowNull: true },

        two_factor_enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        two_factor_secret: { type: Sequelize.STRING(255), allowNull: true, comment: 'AES-256-GCM encrypted' },
        two_factor_pending_secret: {
          type: Sequelize.STRING(255),
          allowNull: true,
          comment: 'Set during 2FA setup',
        },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('users', ['company_id', 'status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('users');
  },
};
