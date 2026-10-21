import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

/** Variant dimension such as Size or Color. */
export const ProductAttribute = sequelize.define(
  'ProductAttribute',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(60), allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { ...baseModelOptions, tableName: 'product_attributes' },
);

export const ProductAttributeValue = sequelize.define(
  'ProductAttributeValue',
  {
    ...idColumn,
    attributeId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    value: { type: DataTypes.STRING(60), allowNull: false },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'product_attribute_values', underscored: true, timestamps: true },
);
