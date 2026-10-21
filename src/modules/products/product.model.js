import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, quantity, tenantColumns } from '../../utils/model.js';

export const PRODUCT_TYPES = ['raw_material', 'finished_good', 'consumable', 'service'];
export const BARCODE_TYPES = ['EAN13', 'CODE128'];

export const Product = sequelize.define(
  'Product',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    sku: { type: DataTypes.STRING(60), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    type: { type: DataTypes.ENUM(...PRODUCT_TYPES), allowNull: false, defaultValue: 'finished_good' },
    barcode: DataTypes.STRING(64),
    barcodeType: { type: DataTypes.ENUM(...BARCODE_TYPES), allowNull: false, defaultValue: 'CODE128' },
    categoryId: DataTypes.BIGINT.UNSIGNED,
    brandId: DataTypes.BIGINT.UNSIGNED,
    baseUnitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    purchasePrice: money(),
    salePrice: money(),
    taxGroupId: DataTypes.BIGINT.UNSIGNED,
    priceIncludesTax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    reorderLevel: quantity(),
    trackBatch: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    trackSerial: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    trackExpiry: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    hasVariants: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    description: DataTypes.TEXT,
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'products' },
);

/** Alternative unit for a product: 1 unit = factor × base unit (e.g. 1 carton = 24 pcs). */
export const ProductUnit = sequelize.define(
  'ProductUnit',
  {
    ...idColumn,
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    unitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    factor: { type: DataTypes.DECIMAL(18, 6), allowNull: false },
    barcode: DataTypes.STRING(64),
    purchasePrice: money({ allowNull: true, defaultValue: null }),
    salePrice: money({ allowNull: true, defaultValue: null }),
    isDefaultPurchase: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isDefaultSale: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: 'product_units', underscored: true, timestamps: true },
);

/** A sellable combination of attribute values (e.g. "Red / M") with its own SKU and barcode. */
export const ProductVariant = sequelize.define(
  'ProductVariant',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    sku: { type: DataTypes.STRING(60), allowNull: false },
    barcode: DataTypes.STRING(64),
    name: { type: DataTypes.STRING(150), allowNull: false },
    purchasePrice: money({ allowNull: true, defaultValue: null }),
    salePrice: money({ allowNull: true, defaultValue: null }),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'product_variants' },
);

export const ProductVariantValue = sequelize.define(
  'ProductVariantValue',
  {
    variantId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    attributeValueId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  },
  { tableName: 'product_variant_values', underscored: true, timestamps: false },
);

export const ProductImage = sequelize.define(
  'ProductImage',
  {
    ...idColumn,
    productId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    path: { type: DataTypes.STRING(500), allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: 'product_images', underscored: true, timestamps: true },
);
