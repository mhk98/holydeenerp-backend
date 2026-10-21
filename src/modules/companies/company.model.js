import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn } from '../../utils/model.js';

export const Company = sequelize.define(
  'Company',
  {
    ...idColumn,
    name: { type: DataTypes.STRING(150), allowNull: false },
    legalName: DataTypes.STRING(200),
    code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
    email: DataTypes.STRING(191),
    phone: DataTypes.STRING(30),
    address: DataTypes.TEXT,
    binNo: DataTypes.STRING(50),
    tinNo: DataTypes.STRING(50),
    vatRegNo: DataTypes.STRING(50),
    website: DataTypes.STRING(191),
    currency: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'BDT' },
    timezone: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'Asia/Dhaka' },
    logoUrl: DataTypes.STRING(500),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdBy: DataTypes.BIGINT.UNSIGNED,
    updatedBy: DataTypes.BIGINT.UNSIGNED,
  },
  { ...baseModelOptions, tableName: 'companies' },
);
