import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Party, PosRegister, PosSession } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { writableWarehouse } from '../inventory/inventory.common.js';
import { findRegister, invalid, registerIncludes } from './pos.common.js';

/** POS registers (counters). A register sells from one warehouse; its branch is the warehouse's. */

const LABEL = 'Register';
const LIST_OPTIONS = {
  sortable: ['name', 'code', 'createdAt'],
  searchable: ['name', 'code'],
  filterable: ['branchId', 'warehouseId', 'isActive'],
  defaultSort: 'name',
};

const scope = (ctx) => ({ branchId: ctx.branchIds.length ? ctx.branchIds : [0] });

export async function listRegisters(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await PosRegister.findAndCountAll({
    where: { ...q.where, ...scope(ctx), companyId: ctx.auth.companyId },
    include: registerIncludes(),
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  const open = await PosSession.findAll({
    where: { registerId: rows.map((r) => r.id), status: 'open' },
    attributes: ['id', 'registerId', 'number', 'openedAt'],
  });
  const openBy = new Map(open.map((s) => [String(s.registerId), s.toJSON()]));
  return {
    rows: rows.map((r) => ({ ...r.toJSON(), openSession: openBy.get(String(r.id)) ?? null })),
    count,
    page: q.page,
    limit: q.limit,
  };
}

export async function getRegister(ctx, id) {
  const register = await PosRegister.findOne({
    where: { id, companyId: ctx.auth.companyId, ...scope(ctx) },
    include: registerIncludes(),
  });
  if (!register) throw AppError.notFound(`${LABEL} not found`);
  return register.toJSON();
}

async function write(ctx, register, input, t) {
  const warehouse = await writableWarehouse(ctx, input.warehouseId, 'warehouseId', t);
  const code = input.code.toUpperCase();
  const clash = await PosRegister.count({
    where: { companyId: ctx.auth.companyId, code, ...(register && { id: { [Op.ne]: register.id } }) },
    transaction: t,
  });
  if (clash)
    throw AppError.conflict(`${LABEL} already exists`, [
      { field: 'code', message: 'This code is already in use' },
    ]);
  if (input.defaultCustomerId) {
    const customer = await Party.count({
      where: { id: input.defaultCustomerId, companyId: ctx.auth.companyId, isCustomer: true },
      transaction: t,
    });
    if (!customer) throw invalid('defaultCustomerId', 'Customer not found');
  }
  if (register && String(register.warehouseId) !== String(warehouse.id)) {
    const open = await PosSession.count({
      where: { registerId: register.id, status: 'open' },
      transaction: t,
    });
    if (open) throw invalid('warehouseId', 'Close the open session before moving the register');
  }
  const values = {
    name: input.name,
    code,
    branchId: warehouse.branchId,
    warehouseId: warehouse.id,
    defaultCustomerId: input.defaultCustomerId ?? null,
    receiptPaper: input.receiptPaper ?? 'thermal_80',
    isActive: input.isActive ?? true,
    notes: input.notes ?? null,
    updatedBy: ctx.auth.userId,
  };
  return register
    ? register.update(values, { transaction: t })
    : PosRegister.create(
        { ...values, companyId: ctx.auth.companyId, createdBy: ctx.auth.userId },
        { transaction: t },
      );
}

export async function createRegister(ctx, input) {
  const register = await sequelize.transaction((t) => write(ctx, null, input, t));
  return getRegister(ctx, register.id);
}

export async function updateRegister(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const register = await PosRegister.findOne({
      where: { id, companyId: ctx.auth.companyId, ...scope(ctx) },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!register) throw AppError.notFound(`${LABEL} not found`);
    await write(ctx, register, input, t);
  });
  return getRegister(ctx, id);
}

/** Registers with history can't be deleted — deactivate them instead. */
export async function deleteRegister(ctx, id) {
  await sequelize.transaction(async (t) => {
    const register = await PosRegister.findOne({
      where: { id, companyId: ctx.auth.companyId, ...scope(ctx) },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!register) throw AppError.notFound(`${LABEL} not found`);
    if (await PosSession.count({ where: { registerId: register.id }, transaction: t }))
      throw AppError.conflict('This register has sessions — deactivate it instead');
    await register.update({ code: retiredValue(register.code, register.id, 30) }, { transaction: t });
    await register.destroy({ transaction: t });
  });
}

export { findRegister };
