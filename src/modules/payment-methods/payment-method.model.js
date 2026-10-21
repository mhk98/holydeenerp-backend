import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, tenantColumns } from '../../utils/model.js';

export const PAYMENT_TYPES = ['cash', 'card', 'mobile_wallet', 'bank_transfer', 'cheque', 'other'];

export const PaymentMethod = sequelize.define(
  'PaymentMethod',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    type: { type: DataTypes.ENUM(...PAYMENT_TYPES), allowNull: false },
    provider: DataTypes.STRING(60),
    accountNumber: DataTypes.STRING(60),
    /** Cash / bank ledger account the money moves through (unset: by type, from the account mapping). */
    accountId: DataTypes.BIGINT.UNSIGNED,
    requiresReference: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'payment_methods' },
);
