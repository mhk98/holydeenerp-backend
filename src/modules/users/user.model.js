import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

/** Columns that must never leave the API. */
export const USER_SECRET_FIELDS = [
  'passwordHash',
  'passwordResetTokenHash',
  'passwordResetExpiresAt',
  'twoFactorSecret',
  'twoFactorPendingSecret',
];

export const User = sequelize.define(
  'User',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    email: { type: DataTypes.STRING(191), allowNull: false, unique: true },
    phone: DataTypes.STRING(30),
    passwordHash: { type: DataTypes.STRING(100), allowNull: false },
    avatarUrl: DataTypes.STRING(500),
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    language: { type: DataTypes.ENUM('en', 'bn'), allowNull: false, defaultValue: 'en' },
    failedLoginAttempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    lockedUntil: DataTypes.DATE,
    lastLoginAt: DataTypes.DATE,
    lastLoginIp: DataTypes.STRING(45),
    passwordChangedAt: DataTypes.DATE,
    passwordResetTokenHash: DataTypes.CHAR(64),
    passwordResetExpiresAt: DataTypes.DATE,
    twoFactorEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    twoFactorSecret: DataTypes.STRING(255),
    twoFactorPendingSecret: DataTypes.STRING(255),
  },
  {
    ...baseModelOptions,
    tableName: 'users',
    defaultScope: { attributes: { exclude: USER_SECRET_FIELDS } },
    scopes: { withSecrets: { attributes: { include: USER_SECRET_FIELDS } } },
  },
);

const joinOptions = { underscored: true, timestamps: true, updatedAt: false };

/** user_roles join table. */
export const UserRole = sequelize.define(
  'UserRole',
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    roleId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  },
  { ...joinOptions, tableName: 'user_roles' },
);

/** user_branches join table. */
export const UserBranch = sequelize.define(
  'UserBranch',
  {
    userId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    branchId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { ...joinOptions, tableName: 'user_branches' },
);
