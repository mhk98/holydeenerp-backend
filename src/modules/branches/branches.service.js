import { Op } from 'sequelize';
import { Branch, UserBranch, Warehouse } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

/** Active branches of the user's company (pickers: user form, warehouse form). */
export async function listBranches(auth) {
  const rows = await Branch.findAll({
    where: { companyId: auth.companyId, isActive: true },
    attributes: ['id', 'name', 'code', 'isHeadOffice', 'phone', 'address'],
    order: [
      ['isHeadOffice', 'DESC'],
      ['name', 'ASC'],
    ],
  });
  return rows.map((b) => ({ ...b.toJSON(), id: String(b.id) }));
}

/** Full branch management (Settings → Branches). Exactly one head office per company. */
export const branchCrud = createCrudService({
  model: Branch,
  label: 'Branch',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'code', 'createdAt'],
    searchable: ['name', 'code', 'phone', 'email'],
    filterable: ['isActive', 'isHeadOffice'],
    defaultSort: 'name',
  },
  beforeSave: async (ctx, data, existing) => {
    if (data.code) data.code = data.code.toUpperCase();
    if (existing?.isHeadOffice && data.isHeadOffice === false) {
      throw AppError.badRequest('Choose another branch as head office instead of unsetting this one');
    }
    if (existing?.isHeadOffice && data.isActive === false) {
      throw AppError.badRequest('The head office cannot be deactivated');
    }
    return data;
  },
  afterSave: async (ctx, branch, data, t) => {
    if (data.isHeadOffice) {
      // Exclude this branch: it is already saved as head office, and re-setting the flag on the
      // instance would be a no-op (Sequelize sees no change) after a blanket reset.
      await Branch.update(
        { isHeadOffice: false },
        {
          where: { companyId: ctx.auth.companyId, isHeadOffice: true, id: { [Op.ne]: branch.id } },
          transaction: t,
        },
      );
    }
  },
  beforeDelete: async (ctx, branch, t) => {
    if (branch.isHeadOffice) throw AppError.badRequest('The head office cannot be deleted');
    const [warehouses, users] = await Promise.all([
      Warehouse.count({ where: { branchId: branch.id }, transaction: t }),
      UserBranch.count({ where: { branchId: branch.id }, transaction: t }),
    ]);
    if (warehouses || users) {
      throw AppError.conflict(
        `This branch still has ${warehouses} warehouse(s) and ${users} user(s). Move or remove them first.`,
      );
    }
  },
});
