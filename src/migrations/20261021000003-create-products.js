'use strict';

const { idColumn, tenantRefs, fk, auditColumns, money, tableOptions } = require('../utils/migration.cjs');

const timestamps = (Sequelize) => ({
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
});

/**
 * Products with alternative units (packs), variants (size/color combinations) and images.
 * Barcodes are unique per company across products, variants and product units (checked in the service).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(
      'products',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        sku: { type: Sequelize.STRING(60), allowNull: false },
        name: { type: Sequelize.STRING(200), allowNull: false },
        type: {
          type: Sequelize.ENUM('raw_material', 'finished_good', 'consumable', 'service'),
          allowNull: false,
          defaultValue: 'finished_good',
        },
        barcode: { type: Sequelize.STRING(64), allowNull: true },
        barcode_type: { type: Sequelize.ENUM('EAN13', 'CODE128'), allowNull: false, defaultValue: 'CODE128' },
        category_id: fk(Sequelize, 'product_categories', { allowNull: true }),
        brand_id: fk(Sequelize, 'brands', { allowNull: true }),
        base_unit_id: fk(Sequelize, 'units'),
        purchase_price: money(Sequelize),
        sale_price: money(Sequelize),
        tax_group_id: fk(Sequelize, 'tax_groups', { allowNull: true }),
        price_includes_tax: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        reorder_level: money(Sequelize, { comment: 'Quantity in base unit' }),
        track_batch: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        track_serial: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        track_expiry: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        has_variants: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        description: { type: Sequelize.TEXT, allowNull: true },
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('products', ['company_id', 'sku'], {
      unique: true,
      name: 'products_company_sku_unique',
    });
    await queryInterface.addIndex('products', ['company_id', 'barcode']);
    await queryInterface.addIndex('products', ['company_id', 'category_id']);
    await queryInterface.addIndex('products', ['company_id', 'name']);

    await queryInterface.createTable(
      'product_units',
      {
        ...idColumn(Sequelize),
        product_id: fk(Sequelize, 'products', { onDelete: 'CASCADE' }),
        unit_id: fk(Sequelize, 'units'),
        factor: { type: Sequelize.DECIMAL(18, 6), allowNull: false, comment: '1 unit = factor × base unit' },
        barcode: { type: Sequelize.STRING(64), allowNull: true },
        purchase_price: money(Sequelize, { allowNull: true, defaultValue: null }),
        sale_price: money(Sequelize, { allowNull: true, defaultValue: null }),
        is_default_purchase: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        is_default_sale: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_units', ['product_id', 'unit_id'], {
      unique: true,
      name: 'product_units_product_unit_unique',
    });

    await queryInterface.createTable(
      'product_variants',
      {
        ...idColumn(Sequelize),
        ...tenantRefs(Sequelize),
        product_id: fk(Sequelize, 'products', { onDelete: 'CASCADE' }),
        sku: { type: Sequelize.STRING(60), allowNull: false },
        barcode: { type: Sequelize.STRING(64), allowNull: true },
        name: { type: Sequelize.STRING(150), allowNull: false, comment: 'e.g. "Red / M"' },
        purchase_price: money(Sequelize, { allowNull: true, defaultValue: null }),
        sale_price: money(Sequelize, { allowNull: true, defaultValue: null }),
        is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        ...auditColumns(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_variants', ['company_id', 'sku'], {
      unique: true,
      name: 'product_variants_company_sku_unique',
    });
    await queryInterface.addIndex('product_variants', ['product_id']);

    await queryInterface.createTable(
      'product_variant_values',
      {
        variant_id: { ...fk(Sequelize, 'product_variants', { onDelete: 'CASCADE' }), primaryKey: true },
        attribute_value_id: { ...fk(Sequelize, 'product_attribute_values'), primaryKey: true },
      },
      tableOptions,
    );

    await queryInterface.createTable(
      'product_images',
      {
        ...idColumn(Sequelize),
        product_id: fk(Sequelize, 'products', { onDelete: 'CASCADE' }),
        path: { type: Sequelize.STRING(500), allowNull: false },
        sort_order: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        is_primary: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        ...timestamps(Sequelize),
      },
      tableOptions,
    );
    await queryInterface.addIndex('product_images', ['product_id', 'sort_order']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('product_images');
    await queryInterface.dropTable('product_variant_values');
    await queryInterface.dropTable('product_variants');
    await queryInterface.dropTable('product_units');
    await queryInterface.dropTable('products');
  },
};
