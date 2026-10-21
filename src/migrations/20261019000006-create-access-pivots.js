'use strict';

const { tableOptions } = require('../utils/migration.cjs');

/**
 * Join tables: role_permissions, user_roles, user_branches.
 * Rows are replaced wholesale when assignments change, so they carry no soft delete.
 */
const fk = (Sequelize, model) => ({
  type: Sequelize.BIGINT.UNSIGNED,
  allowNull: false,
  primaryKey: true,
  references: { model, key: 'id' },
  onDelete: 'CASCADE',
});

const createdAt = (Sequelize) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'role_permissions',
      {
        role_id: fk(Sequelize, 'roles'),
        permission_id: fk(Sequelize, 'permissions'),
        ...createdAt(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.createTable(
      'user_roles',
      { user_id: fk(Sequelize, 'users'), role_id: fk(Sequelize, 'roles'), ...createdAt(Sequelize) },
      tableOptions,
    );
    await queryInterface.createTable(
      'user_branches',
      {
        user_id: fk(Sequelize, 'users'),
        branch_id: fk(Sequelize, 'branches'),
        is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        ...createdAt(Sequelize),
      },
      tableOptions,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('user_branches');
    await queryInterface.dropTable('user_roles');
    await queryInterface.dropTable('role_permissions');
  },
};
