'use strict';

/** Extra company profile fields for invoices and tax filings. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('companies', 'tin_no', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'Taxpayer Identification Number',
      after: 'bin_no',
    });
    await queryInterface.addColumn('companies', 'vat_reg_no', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'VAT registration number',
      after: 'tin_no',
    });
    await queryInterface.addColumn('companies', 'website', {
      type: Sequelize.STRING(191),
      allowNull: true,
      after: 'phone',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('companies', 'website');
    await queryInterface.removeColumn('companies', 'vat_reg_no');
    await queryInterface.removeColumn('companies', 'tin_no');
  },
};
