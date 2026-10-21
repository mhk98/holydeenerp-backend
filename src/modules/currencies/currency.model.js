import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const Currency = sequelize.define(
  'Currency',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    code: { type: DataTypes.CHAR(3), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    symbol: { type: DataTypes.STRING(10), allowNull: false },
    decimalPlaces: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 2 },
    isBase: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'currencies' },
);

/** 1 unit of `currency` = `rate` × base currency, from `effectiveDate`. */
export const ExchangeRate = sequelize.define(
  'ExchangeRate',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    currencyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    rate: { type: DataTypes.DECIMAL(18, 6), allowNull: false },
    effectiveDate: { type: DataTypes.DATEONLY, allowNull: false },
  },
  { ...baseModelOptions, tableName: 'exchange_rates' },
);
