import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const Role = sequelize.define(
  'Role',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(100), allowNull: false },
    slug: { type: DataTypes.STRING(100), allowNull: false },
    description: DataTypes.STRING(255),
    isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { ...baseModelOptions, tableName: 'roles' },
);

/** Global permission catalogue (see permission.catalog.cjs). */
export const Permission = sequelize.define(
  'Permission',
  {
    ...idColumn,
    module: { type: DataTypes.STRING(50), allowNull: false },
    action: { type: DataTypes.STRING(20), allowNull: false },
    key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    description: DataTypes.STRING(255),
  },
  { tableName: 'permissions', underscored: true, timestamps: true },
);

/** role_permissions join table. */
export const RolePermission = sequelize.define(
  'RolePermission',
  {
    roleId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    permissionId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  },
  { tableName: 'role_permissions', underscored: true, timestamps: true, updatedAt: false },
);
