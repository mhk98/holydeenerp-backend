'use strict';

const COMPANY_CODE = 'HOLYDEEN';

/** Demo tenant with three branches. */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.bulkInsert('companies', [
      {
        name: 'Holydeen Trading Ltd.',
        legal_name: 'Holydeen Trading Limited',
        code: COMPANY_CODE,
        email: 'info@holydeen.com',
        phone: '+8809612345678',
        address: 'House 42, Road 11, Banani, Dhaka 1213, Bangladesh',
        bin_no: '004567891-0101',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    ]);
    const [[company]] = await queryInterface.sequelize.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY_CODE],
    });

    const branch = (code, name, phone, address, isHeadOffice = false) => ({
      company_id: company.id,
      code,
      name,
      phone,
      email: `${code.toLowerCase()}@holydeen.com`,
      address,
      is_head_office: isHeadOffice,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    await queryInterface.bulkInsert('branches', [
      branch('HO', 'Dhaka Head Office', '+8801711000001', '72 Motijheel C/A, Dhaka 1000', true),
      branch(
        'CTG',
        'Chattogram Branch',
        '+8801811000002',
        '1112 Sheikh Mujib Road, Agrabad, Chattogram 4100',
      ),
      branch('SYL', 'Sylhet Branch', '+8801911000003', 'Zindabazar Main Road, Sylhet 3100'),
    ]);
  },

  async down(queryInterface) {
    const [[company]] = await queryInterface.sequelize.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY_CODE],
    });
    if (!company) return;
    await queryInterface.bulkDelete('branches', { company_id: company.id });
    await queryInterface.bulkDelete('companies', { id: company.id });
  },
};
