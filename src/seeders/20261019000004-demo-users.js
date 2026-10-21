'use strict';

const bcrypt = require('bcrypt');

/** Development-only password shared by every demo account. */
const DEMO_PASSWORD = 'Password@123';

// [name, email, phone, role slug, branch codes (first = default), status, language]
const USERS = [
  [
    'Tanvir Ahmed',
    'superadmin@holydeen.com',
    '+8801711223344',
    'super-admin',
    ['HO', 'CTG', 'SYL'],
    'active',
    'en',
  ],
  ['Nusrat Jahan', 'admin@holydeen.com', '+8801712345678', 'admin', ['HO', 'CTG', 'SYL'], 'active', 'bn'],
  ['Mahmudul Hasan', 'manager@holydeen.com', '+8801819456123', 'manager', ['HO', 'CTG'], 'active', 'en'],
  ['Farzana Akter', 'accountant@holydeen.com', '+8801915678234', 'accountant', ['HO'], 'active', 'bn'],
  ['Abdul Karim', 'storekeeper@holydeen.com', '+8801612987345', 'store-keeper', ['HO'], 'active', 'bn'],
  ['Sumaiya Rahman', 'cashier@holydeen.com', '+8801555234567', 'cashier', ['CTG'], 'active', 'bn'],
  [
    'Kamrul Hossain',
    'production@holydeen.com',
    '+8801730876543',
    'production-manager',
    ['HO'],
    'active',
    'en',
  ],
  ['Shirin Sultana', 'cashier.sylhet@holydeen.com', '+8801977112233', 'cashier', ['SYL'], 'active', 'bn'],
  ['Rakib Hasan', 'rakib.hasan@holydeen.com', '+8801845998877', 'store-keeper', ['CTG'], 'inactive', 'en'],
];

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query("SELECT id FROM companies WHERE code = 'HOLYDEEN'");
    const [roles] = await db.query('SELECT id, slug FROM roles WHERE company_id = ?', {
      replacements: [company.id],
    });
    const [branches] = await db.query('SELECT id, code FROM branches WHERE company_id = ?', {
      replacements: [company.id],
    });
    const roleId = Object.fromEntries(roles.map((r) => [r.slug, r.id]));
    const branchId = Object.fromEntries(branches.map((b) => [b.code, b.id]));

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const now = new Date();

    await queryInterface.bulkInsert(
      'users',
      USERS.map(([name, email, phone, , , status, language]) => ({
        company_id: company.id,
        name,
        email,
        phone,
        password_hash: passwordHash,
        status,
        language,
        password_changed_at: now,
        created_at: now,
        updated_at: now,
      })),
    );

    const [users] = await db.query('SELECT id, email FROM users WHERE company_id = ?', {
      replacements: [company.id],
    });
    const userId = Object.fromEntries(users.map((u) => [u.email, u.id]));

    await queryInterface.bulkInsert(
      'user_roles',
      USERS.map(([, email, , role]) => ({ user_id: userId[email], role_id: roleId[role], created_at: now })),
    );
    await queryInterface.bulkInsert(
      'user_branches',
      USERS.flatMap(([, email, , , codes]) =>
        codes.map((code, i) => ({
          user_id: userId[email],
          branch_id: branchId[code],
          is_default: i === 0,
          created_at: now,
        })),
      ),
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('users', { email: USERS.map((u) => u[1]) });
  },
};
