'use strict';
/**
 * Sales demo for Holydeen Trading Ltd.: a "Wholesale" price list for the WHOLESALE customer group
 * (5 % off the first products, and a fixed bulk price from 10 units on one of them), plus credit
 * limits on the wholesale customers so the credit check can be tried. Re-running is harmless.
 */
const COMPANY = 'HOLYDEEN';
const CODE = 'WHOLESALE';

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    const [[exists]] = await db.query('SELECT id FROM price_lists WHERE company_id = ? AND code = ?', {
      replacements: [company.id, CODE],
    });
    if (exists) return;
    const [[group]] = await db.query(
      "SELECT id FROM party_groups WHERE company_id = ? AND type = 'customer' AND code = 'WHOLESALE'",
      { replacements: [company.id] },
    );
    const [products] = await db.query(
      `SELECT id, sale_price FROM products
        WHERE company_id = ? AND is_active = 1 AND has_variants = 0 AND deleted_at IS NULL AND sale_price > 0
        ORDER BY id LIMIT 6`,
      { replacements: [company.id] },
    );
    if (!products.length) return;

    const now = new Date();
    await queryInterface.bulkInsert('price_lists', [
      {
        company_id: company.id,
        name: 'Wholesale',
        code: CODE,
        customer_group_id: group ? group.id : null,
        valid_from: null,
        valid_to: null,
        priority: 10,
        is_active: true,
        notes: 'Bulk buyers: 5 % off, special price from 10 units.',
        created_at: now,
        updated_at: now,
      },
    ]);
    const [[list]] = await db.query('SELECT id FROM price_lists WHERE company_id = ? AND code = ?', {
      replacements: [company.id, CODE],
    });
    const rows = products.map((p) => ({
      price_list_id: list.id,
      product_id: p.id,
      variant_id: null,
      unit_id: null,
      price: null,
      discount_percent: '5.0000',
      min_quantity: '0.0000',
      created_at: now,
      updated_at: now,
    }));
    // A fixed bulk price (10 % below the standard price) on the first product from 10 units.
    rows.push({
      ...rows[0],
      price: (Number(products[0].sale_price) * 0.9).toFixed(4),
      discount_percent: null,
      min_quantity: '10.0000',
    });
    await queryInterface.bulkInsert('price_list_items', rows);

    if (group) {
      await db.query(
        'UPDATE parties SET credit_limit = 500000 WHERE company_id = ? AND customer_group_id = ? AND credit_limit = 0',
        { replacements: [company.id, group.id] },
      );
    }
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    await db.query('DELETE FROM price_lists WHERE company_id = ? AND code = ?', {
      replacements: [company.id, CODE],
    });
  },
};
