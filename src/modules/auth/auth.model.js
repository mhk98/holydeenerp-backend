import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { idColumn } from '../../utils/model.js';

/** Hashed refresh tokens grouped into families (one family per login = one session). */
export const RefreshToken = sequelize.define(
  'RefreshToken',
  {
    ...idColumn,
    userId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    familyId: { type: DataTypes.CHAR(36), allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    ip: DataTypes.STRING(45),
    userAgent: DataTypes.STRING(500),
    deviceName: DataTypes.STRING(150),
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastUsedAt: DataTypes.DATE,
    revokedAt: DataTypes.DATE,
    revokedReason: DataTypes.STRING(30),
  },
  { tableName: 'refresh_tokens', underscored: true, timestamps: true },
);

/** Append-only record of login attempts. */
export const LoginHistory = sequelize.define(
  'LoginHistory',
  {
    ...idColumn,
    companyId: DataTypes.BIGINT.UNSIGNED,
    userId: DataTypes.BIGINT.UNSIGNED,
    email: { type: DataTypes.STRING(191), allowNull: false },
    ip: DataTypes.STRING(45),
    userAgent: DataTypes.STRING(500),
    deviceName: DataTypes.STRING(150),
    success: { type: DataTypes.BOOLEAN, allowNull: false },
    failureReason: DataTypes.STRING(50),
  },
  { tableName: 'login_history', underscored: true, timestamps: true, updatedAt: false },
);
