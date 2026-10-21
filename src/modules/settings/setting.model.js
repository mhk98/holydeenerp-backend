import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn } from '../../utils/model.js';

/** One JSON document per (company, group); companyId NULL = system-wide group. */
export const Setting = sequelize.define(
  'Setting',
  {
    ...idColumn,
    companyId: DataTypes.BIGINT.UNSIGNED,
    group: { type: DataTypes.STRING(40), allowNull: false },
    value: { type: DataTypes.TEXT('medium'), allowNull: false },
    createdBy: DataTypes.BIGINT.UNSIGNED,
    updatedBy: DataTypes.BIGINT.UNSIGNED,
  },
  { ...baseModelOptions, paranoid: false, tableName: 'settings' },
);

export const PRINT_DOC_TYPES = [
  'invoice',
  'pos_receipt',
  'quotation',
  'purchase_order',
  'delivery_note',
  'money_receipt',
];
export const PAPER_SIZES = ['a4', 'thermal_80'];

export const PrintTemplate = sequelize.define(
  'PrintTemplate',
  {
    ...idColumn,
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    docType: { type: DataTypes.STRING(40), allowNull: false },
    paper: { type: DataTypes.ENUM(...PAPER_SIZES), allowNull: false },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    options: {
      type: DataTypes.TEXT,
      allowNull: false,
      get() {
        const raw = this.getDataValue('options');
        return raw ? JSON.parse(raw) : {};
      },
      set(value) {
        this.setDataValue('options', JSON.stringify(value ?? {}));
      },
    },
    terms: DataTypes.TEXT,
    footerNote: DataTypes.STRING(500),
    createdBy: DataTypes.BIGINT.UNSIGNED,
    updatedBy: DataTypes.BIGINT.UNSIGNED,
  },
  { ...baseModelOptions, tableName: 'print_templates' },
);
