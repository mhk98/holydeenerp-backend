import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const Warehouse = sequelize.define(
  'Warehouse',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    phone: DataTypes.STRING(30),
    address: DataTypes.TEXT,
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'warehouses' },
);
