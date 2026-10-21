import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, tenantColumns } from '../../utils/model.js';

export const PARTY_TYPES = ['customer', 'supplier'];
export const ADDRESS_TYPES = ['billing', 'shipping', 'other'];

export const PartyGroup = sequelize.define(
  'PartyGroup',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    type: { type: DataTypes.ENUM(...PARTY_TYPES), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    code: { type: DataTypes.STRING(30), allowNull: false },
    description: DataTypes.STRING(255),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'party_groups' },
);

/** A customer, a supplier, or both. */
export const Party = sequelize.define(
  'Party',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    code: { type: DataTypes.STRING(30), allowNull: false },
    name: { type: DataTypes.STRING(200), allowNull: false },
    contactPerson: DataTypes.STRING(150),
    phone: DataTypes.STRING(30),
    email: DataTypes.STRING(191),
    binNo: DataTypes.STRING(50),
    tinNo: DataTypes.STRING(50),
    isCustomer: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isSupplier: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    customerGroupId: DataTypes.BIGINT.UNSIGNED,
    supplierGroupId: DataTypes.BIGINT.UNSIGNED,
    creditLimit: money(),
    paymentTermsDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
    openingBalance: money(),
    openingBalanceType: { type: DataTypes.ENUM('debit', 'credit'), allowNull: false, defaultValue: 'debit' },
    notes: DataTypes.TEXT,
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { ...baseModelOptions, tableName: 'parties' },
);

export const PartyAddress = sequelize.define(
  'PartyAddress',
  {
    ...idColumn,
    partyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    type: { type: DataTypes.ENUM(...ADDRESS_TYPES), allowNull: false, defaultValue: 'billing' },
    label: DataTypes.STRING(60),
    addressLine: { type: DataTypes.STRING(500), allowNull: false },
    city: DataTypes.STRING(100),
    district: DataTypes.STRING(100),
    postalCode: DataTypes.STRING(20),
    country: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'Bangladesh' },
    phone: DataTypes.STRING(30),
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: 'party_addresses', underscored: true, timestamps: true },
);
