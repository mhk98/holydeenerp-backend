import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { idColumn } from '../../utils/model.js';

export const BACKUP_TYPES = ['manual', 'scheduled'];
export const BACKUP_STATUSES = ['running', 'completed', 'failed'];

/** Database backup files (whole database, so not tenant-scoped). Rows are never updated by users. */
export const Backup = sequelize.define(
  'Backup',
  {
    ...idColumn,
    fileName: { type: DataTypes.STRING(200), allowNull: false, unique: true },
    sizeBytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    type: { type: DataTypes.ENUM(...BACKUP_TYPES), allowNull: false },
    status: { type: DataTypes.ENUM(...BACKUP_STATUSES), allowNull: false, defaultValue: 'running' },
    tablesCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    rowsCount: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    error: DataTypes.STRING(1000),
    createdBy: DataTypes.BIGINT.UNSIGNED,
    completedAt: DataTypes.DATE,
  },
  { underscored: true, timestamps: true, updatedAt: false, paranoid: false, tableName: 'backups' },
);
