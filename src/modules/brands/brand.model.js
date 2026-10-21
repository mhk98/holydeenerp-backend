import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const Brand = sequelize.define(
  'Brand',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    description: DataTypes.STRING(500),
    logoUrl: DataTypes.STRING(500),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'brands' },
);
