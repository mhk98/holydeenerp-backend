import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const TAX_TYPES = ['vat', 'sd', 'ait', 'other'];

export const TaxRate = sequelize.define(
  'TaxRate',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    type: { type: DataTypes.ENUM(...TAX_TYPES), allowNull: false, defaultValue: 'vat' },
    rate: { type: DataTypes.DECIMAL(9, 4), allowNull: false },
    description: DataTypes.STRING(255),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'tax_rates' },
);

export const TaxGroup = sequelize.define(
  'TaxGroup',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    description: DataTypes.STRING(255),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'tax_groups' },
);

/** Rates in a group, applied in `sequence` order; compound rates apply on amount + earlier taxes. */
export const TaxGroupRate = sequelize.define(
  'TaxGroupRate',
  {
    taxGroupId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    taxRateId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    sequence: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    isCompound: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: 'tax_group_rates', underscored: true, timestamps: true, updatedAt: false },
);
