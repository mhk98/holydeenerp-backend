import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

/** branchId NULL = company-wide series used when a branch has no series of its own. */
export const DocumentSequence = sequelize.define(
  'DocumentSequence',
  {
    ...idColumn,
    ...tenantColumns(),
    docType: { type: DataTypes.STRING(40), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    prefix: { type: DataTypes.STRING(50), allowNull: false, defaultValue: '' },
    suffix: { type: DataTypes.STRING(50), allowNull: false, defaultValue: '' },
    padding: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 5 },
    nextNumber: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    resetYearly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    currentYear: DataTypes.SMALLINT.UNSIGNED,
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'document_sequences' },
);
