import { Op } from 'sequelize';
import { Branch, StockMovement, Warehouse } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

/**
 * Warehouses are branch-level data: users only see warehouses of their branches
 * (or the branch picked in the branch switcher). One default warehouse per branch.
 */
export const warehouseCrud = createCrudService({
  model: Warehouse,
  label: 'Warehouse',
  uniqueFields: ['code'],
  include: () => [{ model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] }],
  listOptions: {
    sortable: ['name', 'code', 'createdAt'],
    searchable: ['name', 'code', 'address'],
    filterable: ['branchId', 'isActive'],
    defaultSort: 'name',
  },
  // Always limited to the request's branches; a ?branchId= filter can only narrow further.
  scopeWhere: (ctx) => ({ branchId: { [Op.in]: ctx.branchIds.length ? ctx.branchIds : [0] } }),
  beforeSave: async (ctx, data, existing, t) => {
    if (data.code) data.code = data.code.toUpperCase();
    const branchId = data.branchId ?? existing?.branchId;
    if (data.branchId !== undefined) {
      const branch = await Branch.findOne({
        where: { id: data.branchId, companyId: ctx.auth.companyId },
        transaction: t,
      });
      if (!branch) {
        throw AppError.unprocessable('Validation failed', [
          { field: 'branchId', message: 'Branch not found' },
        ]);
      }
    }
    if (!ctx.branchIds.includes(String(branchId))) {
      throw AppError.forbidden('You do not have access to this branch');
    }
    return data;
  },
  afterSave: async (ctx, warehouse, data, t) => {
    const branchWarehouses = await Warehouse.count({
      where: { branchId: warehouse.branchId },
      transaction: t,
    });
    // The first warehouse of a branch, or one explicitly marked, becomes the branch default.
    if (data.isDefault || branchWarehouses === 1) {
      await Warehouse.update(
        { isDefault: false },
        { where: { branchId: warehouse.branchId, id: { [Op.ne]: warehouse.id } }, transaction: t },
      );
      await warehouse.update({ isDefault: true }, { transaction: t });
    }
  },
  beforeDelete: async (ctx, warehouse, t) => {
    // Movements reference the warehouse forever; deactivate it instead.
    if (await StockMovement.count({ where: { warehouseId: warehouse.id }, transaction: t })) {
      throw AppError.conflict(
        'This warehouse has stock history and cannot be deleted; mark it inactive instead',
      );
    }
  },
});
