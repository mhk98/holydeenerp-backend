import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

/** Nested product category (parentId NULL = top level). */
export const ProductCategory = sequelize.define(
  'ProductCategory',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    parentId: DataTypes.BIGINT.UNSIGNED,
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    description: DataTypes.STRING(500),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'product_categories' },
);
