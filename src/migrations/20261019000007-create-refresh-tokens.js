'use strict';

const { idColumn, tableOptions } = require('../utils/migration.cjs');

/**
 * One row per issued refresh token (only the SHA-256 hash is stored).
 * A login starts a "family"; each rotation adds a row to it. Reusing a rotated
 * token revokes the whole family. Active families are the user's sessions.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'refresh_tokens',
      {
        ...idColumn(Sequelize),
        user_id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          references: { model: 'users', key: 'id' },
          onDelete: 'CASCADE',
        },
        family_id: { type: Sequelize.CHAR(36), allowNull: false },
        token_hash: { type: Sequelize.CHAR(64), allowNull: false, unique: true },
        ip: { type: Sequelize.STRING(45), allowNull: true },
        user_agent: { type: Sequelize.STRING(500), allowNull: true },
        device_name: { type: Sequelize.STRING(150), allowNull: true },
        expires_at: { type: Sequelize.DATE, allowNull: false },
        last_used_at: { type: Sequelize.DATE, allowNull: true },
        revoked_at: { type: Sequelize.DATE, allowNull: true },
        revoked_reason: { type: Sequelize.STRING(30), allowNull: true },
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
      },
      tableOptions,
    );
    await queryInterface.addIndex('refresh_tokens', ['user_id', 'revoked_at']);
    await queryInterface.addIndex('refresh_tokens', ['family_id']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('refresh_tokens');
  },
};
