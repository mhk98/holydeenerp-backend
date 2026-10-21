'use strict';

const { idColumn, auditColumns, tableOptions } = require('../utils/migration.cjs');

/** Tenants. The tenant table itself has no company_id. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'companies',
      {
        ...idColumn(Sequelize),
        name: { type: Sequelize.STRING(150), allowNull: false },
        legal_name: { type: Sequelize.STRING(200), allowNull: true },
        code: { type: Sequelize.STRING(30), allowNull: false, unique: true },
        email: { type: Sequelize.STRING(191), allowNull: true },
        phone: { type: Sequelize.STRING(30), allowNull: true },
        address: { type: Sequelize.TEXT, allowNull: true },
        bin_no: {
          type: Sequelize.STRING(50),
          allowNull: true,
          comment: 'VAT Business Identification Number',
        },
        currency: { type: Sequelize.CHAR(3), allowNull: false, defaultValue: 'BDT' },
        timezone: { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'Asia/Dhaka' },
        logo_url: { type: Sequelize.STRING(500), allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('companies');
  },
};
