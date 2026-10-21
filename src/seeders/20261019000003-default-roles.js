'use strict';

const { DEFAULT_ROLES, presetKeys } = require('../modules/roles/permission.catalog.cjs');

/** The seven default roles for the demo company, with their permission sets. */
module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query("SELECT id FROM companies WHERE code = 'HOLYDEEN'");
    const [permissions] = await db.query('SELECT id, `key` FROM permissions');
    const permissionId = Object.fromEntries(permissions.map((p) => [p.key, p.id]));
    const now = new Date();

    await queryInterface.bulkInsert(
      'roles',
      DEFAULT_ROLES.map((r) => ({
        company_id: company.id,
        name: r.name,
        slug: r.slug,
        description: r.description,
        is_system: Boolean(r.isSystem),
        created_at: now,
        updated_at: now,
      })),
    );

    const [roles] = await db.query('SELECT id, slug FROM roles WHERE company_id = ?', {
      replacements: [company.id],
    });
    const roleId = Object.fromEntries(roles.map((r) => [r.slug, r.id]));

    const rows = DEFAULT_ROLES.flatMap((r) =>
      presetKeys(r.permissions).map((key) => ({
        role_id: roleId[r.slug],
        permission_id: permissionId[key],
        created_at: now,
      })),
    );
    await queryInterface.bulkInsert('role_permissions', rows);
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query("SELECT id FROM companies WHERE code = 'HOLYDEEN'");
    if (!company) return;
    await db.query(
      'DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.company_id = ?',
      {
        replacements: [company.id],
      },
    );
    await queryInterface.bulkDelete('roles', { company_id: company.id });
  },
};
