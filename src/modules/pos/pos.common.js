import { Branch, Party, PosRegister, PosSession, User, Warehouse } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { assertBranchAccess } from '../inventory/inventory.common.js';
import { getSettings } from '../settings/settings.service.js';
import { D, fixed, invalid } from '../sales/sales.common.js';

export { D, fixed, invalid };

export const posSettings = (companyId, t) => getSettings(companyId, 'pos', t);

export const can = (ctx, permission) =>
  ctx.auth.isSuperAdmin || ctx.auth.permissions.includes('*') || ctx.auth.permissions.includes(permission);

export const registerIncludes = () => [
  { model: Branch, as: 'branch', attributes: ['id', 'name', 'code'] },
  { model: Warehouse, as: 'warehouse', attributes: ['id', 'name', 'code'] },
  { model: Party, as: 'defaultCustomer', attributes: ['id', 'code', 'name', 'phone', 'email'] },
];

export const userRef = (as) => ({ model: User, as, attributes: ['id', 'name'] });

/** An active register the user's branches include. */
export async function findRegister(ctx, id, t, { field = 'registerId', lock = false } = {}) {
  const register = await PosRegister.findOne({
    where: { id, companyId: ctx.auth.companyId },
    include: registerIncludes(),
    transaction: t,
    ...(lock && t && { lock: t.LOCK.UPDATE }),
  });
  if (!register) throw invalid(field, 'Register not found');
  if (!register.isActive) throw invalid(field, `Register ${register.name} is inactive`);
  assertBranchAccess(ctx, register.branchId);
  return register;
}

/** The open session of a register, or null. */
export const openSessionOf = (registerId, t) =>
  PosSession.findOne({ where: { registerId, status: 'open' }, transaction: t });

/** A session of the company the user may work with (branch access). */
export async function findSession(ctx, id, t, { lock = false } = {}) {
  const session = await PosSession.findOne({
    where: { id, companyId: ctx.auth.companyId },
    transaction: t,
    ...(lock && t && { lock: t.LOCK.UPDATE }),
  });
  if (!session) throw AppError.notFound('Register session not found');
  assertBranchAccess(ctx, session.branchId);
  return session;
}
