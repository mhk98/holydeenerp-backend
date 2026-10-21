import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Branch, Role, User, UserBranch, UserRole } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { hashPassword } from '../auth/password.js';
import { revokeAllSessions } from '../auth/token.service.js';
import catalog from '../roles/permission.catalog.cjs';

const { SUPER_ADMIN_SLUG } = catalog;

const LIST_OPTIONS = {
  sortable: ['name', 'email', 'status', 'lastLoginAt', 'createdAt'],
  searchable: ['name', 'email', 'phone'],
  filterable: ['status'],
  defaultSort: 'name',
};

const includes = () => [
  { model: Role, as: 'roles', attributes: ['id', 'name', 'slug'], through: { attributes: [] } },
  {
    model: Branch,
    as: 'branches',
    attributes: ['id', 'name', 'code'],
    through: { attributes: ['isDefault'] },
  },
];

export function serializeUser(user) {
  const locked = Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    status: user.status,
    language: user.language,
    twoFactorEnabled: user.twoFactorEnabled,
    isLocked: locked,
    lockedUntil: locked ? user.lockedUntil : null,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    roles: (user.roles ?? []).map((r) => ({ id: String(r.id), name: r.name, slug: r.slug })),
    branches: (user.branches ?? []).map((b) => ({
      id: String(b.id),
      name: b.name,
      code: b.code,
      isDefault: Boolean(b.UserBranch?.isDefault),
    })),
  };
}

const isSuperAdminUser = (user) => (user.roles ?? []).some((r) => r.slug === SUPER_ADMIN_SLUG);

async function userIdsWith(model, where) {
  const rows = await model.findAll({ where, attributes: ['userId'], raw: true });
  return rows.map((r) => r.userId);
}

export async function listUsers(auth, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = { ...q.where, companyId: auth.companyId };

  // Role/branch filters resolve to id lists first so pagination counts stay correct.
  const idFilters = [];
  if (query.roleId) idFilters.push(await userIdsWith(UserRole, { roleId: query.roleId }));
  if (query.branchId) idFilters.push(await userIdsWith(UserBranch, { branchId: query.branchId }));
  if (idFilters.length) {
    const ids = idFilters.reduce((acc, list) => acc.filter((id) => list.includes(id)));
    where.id = { [Op.in]: ids };
  }

  const result = await User.findAndCountAll({
    where,
    include: includes(),
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: result.rows.map(serializeUser), count: result.count, page: q.page, limit: q.limit };
}

async function findUser(auth, id, options = {}) {
  const user = await User.findOne({
    where: { id, companyId: auth.companyId },
    include: includes(),
    ...options,
  });
  if (!user) throw AppError.notFound('User not found');
  return user;
}

export async function getUser(auth, id) {
  return serializeUser(await findUser(auth, id));
}

/** Roles and branches must belong to the actor's company; only Super Admins may grant Super Admin. */
async function resolveAssignments(auth, { roleIds, branchIds }) {
  const result = {};
  if (roleIds) {
    const roles = await Role.findAll({ where: { id: roleIds, companyId: auth.companyId } });
    if (roles.length !== roleIds.length) {
      throw AppError.unprocessable('Validation failed', [
        { field: 'roleIds', message: 'One or more roles are invalid' },
      ]);
    }
    if (!auth.isSuperAdmin && roles.some((r) => r.slug === SUPER_ADMIN_SLUG)) {
      throw AppError.forbidden('Only a Super Admin can assign the Super Admin role');
    }
    result.roles = roles;
  }
  if (branchIds) {
    const count = await Branch.count({ where: { id: branchIds, companyId: auth.companyId } });
    if (count !== branchIds.length) {
      throw AppError.unprocessable('Validation failed', [
        { field: 'branchIds', message: 'One or more branches are invalid' },
      ]);
    }
  }
  return result;
}

async function assertEmailAvailable(email, exceptId) {
  const existing = await User.findOne({ where: { email }, paranoid: false, attributes: ['id'] });
  if (existing && String(existing.id) !== String(exceptId)) {
    throw AppError.conflict('Email already in use', [
      { field: 'email', message: 'This email is already in use' },
    ]);
  }
}

async function countSuperAdmins(companyId) {
  return User.count({
    where: { companyId, status: 'active' },
    include: [{ model: Role, as: 'roles', where: { slug: SUPER_ADMIN_SLUG }, through: { attributes: [] } }],
    distinct: true,
  });
}

async function writeAssignments(userId, { roleIds, branchIds, defaultBranchId }, transaction) {
  if (roleIds) {
    await UserRole.destroy({ where: { userId }, transaction });
    await UserRole.bulkCreate(
      roleIds.map((roleId) => ({ userId, roleId })),
      { transaction },
    );
  }
  if (branchIds) {
    const fallbackDefault = defaultBranchId ?? branchIds[0];
    await UserBranch.destroy({ where: { userId }, transaction });
    await UserBranch.bulkCreate(
      branchIds.map((branchId) => ({
        userId,
        branchId,
        isDefault: String(branchId) === String(fallbackDefault),
      })),
      { transaction },
    );
  }
}

export async function createUser(auth, data) {
  await assertEmailAvailable(data.email);
  await resolveAssignments(auth, data);

  const { roleIds, branchIds, defaultBranchId, password, ...fields } = data;
  const user = await sequelize.transaction(async (transaction) => {
    const created = await User.create(
      {
        ...fields,
        companyId: auth.companyId,
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
      { transaction },
    );
    await writeAssignments(created.id, { roleIds, branchIds, defaultBranchId }, transaction);
    return created;
  });
  return getUser(auth, user.id);
}

/** Non-Super-Admins cannot modify Super Admin accounts. */
function assertCanManage(auth, target) {
  if (!auth.isSuperAdmin && isSuperAdminUser(target)) {
    throw AppError.forbidden('Only a Super Admin can modify a Super Admin account');
  }
}

export async function updateUser(auth, id, data) {
  const user = await findUser(auth, id);
  assertCanManage(auth, user);
  const isSelf = String(user.id) === String(auth.userId);

  if (data.email && data.email !== user.email) await assertEmailAvailable(data.email, user.id);
  const { roles } = await resolveAssignments(auth, data);

  if (isSelf && data.status === 'inactive')
    throw AppError.badRequest('You cannot deactivate your own account');
  const losesSuperAdmin = isSuperAdminUser(user) && roles && !roles.some((r) => r.slug === SUPER_ADMIN_SLUG);
  if ((losesSuperAdmin || data.status === 'inactive') && isSuperAdminUser(user)) {
    if ((await countSuperAdmins(auth.companyId)) <= 1) {
      throw AppError.badRequest('The company must keep at least one active Super Admin');
    }
  }

  const { roleIds, branchIds, defaultBranchId, password, ...fields } = data;
  await sequelize.transaction(async (transaction) => {
    const patch = { ...fields, updatedBy: auth.userId };
    if (password)
      Object.assign(patch, { passwordHash: await hashPassword(password), passwordChangedAt: new Date() });
    if (fields.status === 'active') Object.assign(patch, { failedLoginAttempts: 0, lockedUntil: null });
    await user.update(patch, { transaction });
    await writeAssignments(user.id, { roleIds, branchIds, defaultBranchId }, transaction);
  });

  if (password || fields.status === 'inactive') {
    await revokeAllSessions(user.id, {
      exceptSessionId: isSelf ? auth.sessionId : undefined,
      reason: password ? 'password_changed' : 'deactivated',
    });
  }
  return getUser(auth, user.id);
}

export async function setStatus(auth, id, status) {
  return updateUser(auth, id, { status });
}

export async function deleteUser(auth, id) {
  const user = await findUser(auth, id);
  assertCanManage(auth, user);
  if (String(user.id) === String(auth.userId))
    throw AppError.badRequest('You cannot delete your own account');
  if (isSuperAdminUser(user) && (await countSuperAdmins(auth.companyId)) <= 1) {
    throw AppError.badRequest('The company must keep at least one active Super Admin');
  }

  await sequelize.transaction(async (transaction) => {
    // Free the unique email so it can be reused by a new account.
    await user.update({ email: retiredValue(user.email, user.id), updatedBy: auth.userId }, { transaction });
    await user.destroy({ transaction });
  });
  await revokeAllSessions(user.id, { reason: 'deleted' });
}
