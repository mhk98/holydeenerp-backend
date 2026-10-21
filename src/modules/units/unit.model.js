import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const UNIT_CATEGORIES = ['count', 'weight', 'volume', 'length', 'area', 'time', 'other'];

export const Unit = sequelize.define(
  'Unit',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(60), allowNull: false },
    code: { type: DataTypes.STRING(20), allowNull: false },
    category: { type: DataTypes.ENUM(...UNIT_CATEGORIES), allowNull: false, defaultValue: 'count' },
    allowDecimal: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'units' },
);

/** 1 fromUnit = factor × toUnit (e.g. 1 box = 12 pcs). */
export const UnitConversion = sequelize.define(
  'UnitConversion',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    fromUnitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    toUnitId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    factor: { type: DataTypes.DECIMAL(18, 6), allowNull: false },
  },
  { ...baseModelOptions, tableName: 'unit_conversions' },
);
