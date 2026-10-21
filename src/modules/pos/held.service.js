import { sequelize } from '../../config/db.js';
import { Party, PosHeldOrder } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { findRegister, fixed, userRef } from './pos.common.js';

/** Parked carts. Any register of the branch can recall one; recalling removes it. */

export async function listHeld(ctx, { registerId }) {
  const register = await findRegister(ctx, registerId);
  const rows = await PosHeldOrder.findAll({
    where: { companyId: ctx.auth.companyId, branchId: register.branchId },
    include: [{ model: Party, as: 'customer', attributes: ['id', 'code', 'name'] }, userRef('creator')],
    order: [['id', 'DESC']],
  });
  return rows.map((r) => r.toJSON());
}

export async function holdOrder(ctx, { registerId, label, customerId, cart, total }) {
  const register = await findRegister(ctx, registerId);
  const row = await PosHeldOrder.create({
    companyId: ctx.auth.companyId,
    branchId: register.branchId,
    registerId: register.id,
    label,
    customerId: customerId ?? null,
    cart,
    total: fixed(total ?? 0),
    createdBy: ctx.auth.userId,
    updatedBy: ctx.auth.userId,
  });
  return row.toJSON();
}

/** Take a held cart back (deletes it so two registers can't ring it up twice). */
export async function recallOrder(ctx, id) {
  return sequelize.transaction(async (t) => {
    const row = await PosHeldOrder.findOne({
      where: { id, companyId: ctx.auth.companyId, branchId: ctx.branchIds.length ? ctx.branchIds : [0] },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw AppError.notFound('Held order not found (it may have been recalled already)');
    const json = row.toJSON();
    await row.destroy({ transaction: t });
    return json;
  });
}
