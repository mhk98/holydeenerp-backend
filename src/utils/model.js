import { DataTypes } from 'sequelize';

/** DECIMAL(18,4) for money and quantities. Values come back as strings — never floats. */
export const money = (opts = {}) => ({
  type: DataTypes.DECIMAL(18, 4),
  allowNull: false,
  defaultValue: '0.0000',
  ...opts,
});

export const quantity = money;

/** Primary key used by every table. */
export const idColumn = {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
};

/**
 * Tenant + audit columns shared by every model. Pass { branch: false } for
 * company-level tables that are not branch specific.
 */
export function tenantColumns({ branch = true } = {}) {
  return {
    companyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    ...(branch && { branchId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true } }),
    createdBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    updatedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
  };
}

/** Model options: snake_case columns, timestamps and paranoid soft delete. */
export const baseModelOptions = {
  underscored: true,
  timestamps: true,
  paranoid: true,
};
