'use strict';

const { ALL_PERMISSIONS } = require('../modules/roles/permission.catalog.cjs');

const label = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Every module × action permission (14 × 7 = 98). Safe to re-run: existing keys are skipped. */
module.exports = {
  async up(queryInterface) {
    const [existing] = await queryInterface.sequelize.query('SELECT `key` FROM permissions');
    const have = new Set(existing.map((r) => r.key));
    const now = new Date();
    const rows = ALL_PERMISSIONS.filter((p) => !have.has(p.key)).map((p) => ({
      module: p.module,
      action: p.action,
      key: p.key,
      description: `${label(p.action)} ${label(p.module)}`,
      created_at: now,
      updated_at: now,
    }));
    if (rows.length) await queryInterface.bulkInsert('permissions', rows);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('permissions', null, {});
  },
};
