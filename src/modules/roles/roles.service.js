import { fn, col } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Permission, Role, RolePermission, UserRole } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue, slugify } from '../../utils/slug.js';
import catalog from './permission.catalog.cjs';

const LIST_OPTIONS = {
  sortable: ['name', 'createdAt'],
  searchable: ['name', 'description'],
  defaultSort: 'name',
};

/** Module × action catalogue for the permission matrix. */
export async function getCatalog() {
  const permissions = await Permission.findAll({
    attributes: ['key', 'module', 'action'],
    order: [['id', 'ASC']],
  });
  return { modules: catalog.MODULES, actions: catalog.ACTIONS, permissions };
}

async function countsByRole(model, roleIds) {
  if (!roleIds.length) return {};
  const rows = await model.findAll({
    where: { roleId: roleIds },
    attributes: ['roleId', [fn('COUNT', col('role_id')), 'total']],
    group: ['roleId'],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [String(r.roleId), Number(r.total)]));
}

function serializeRole(role, { usersCount, permissionsCount, permissionKeys } = {}) {
  const isSuperAdmin = role.slug === catalog.SUPER_ADMIN_SLUG;
  return {
    id: String(role.id),
    name: role.name,
    slug: role.slug,
    description: role.description,
    isSystem: role.isSystem,
    isSuperAdmin,
    usersCount: usersCount ?? 0,
    permissionsCount: isSuperAdmin ? catalog.ALL_PERMISSIONS.length : (permissionsCount ?? 0),
    ...(permissionKeys && {
      permissionKeys: isSuperAdmin ? catalog.ALL_PERMISSIONS.map((p) => p.key) : permissionKeys,
    }),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export async function listRoles(auth, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await Role.findAndCountAll({
    where: { ...q.where, companyId: auth.companyId },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
  });
  const ids = rows.map((r) => r.id);
  const [users, perms] = await Promise.all([countsByRole(UserRole, ids), countsByRole(RolePermission, ids)]);
  return {
    rows: rows.map((r) =>
      serializeRole(r, { usersCount: users[String(r.id)], permissionsCount: perms[String(r.id)] }),
    ),
    count,
    page: q.page,
    limit: q.limit,
  };
}

async function findRole(auth, id, transaction) {
  const role = await Role.findOne({ where: { id, companyId: auth.companyId }, transaction });
  if (!role) throw AppError.notFound('Role not found');
  return role;
}

export async function getRole(auth, id) {
  const role = await Role.findOne({
    where: { id, companyId: auth.companyId },
    include: [{ model: Permission, as: 'permissions', attributes: ['key'], through: { attributes: [] } }],
  });
  if (!role) throw AppError.notFound('Role not found');
  const users = await countsByRole(UserRole, [role.id]);
  const permissionKeys = role.permissions.map((p) => p.key).sort();
  return serializeRole(role, {
    usersCount: users[String(role.id)],
    permissionsCount: permissionKeys.length,
    permissionKeys,
  });
}

/** Map keys to permission rows; reject unknown keys and keys the actor does not hold. */
async function resolvePermissions(auth, keys) {
  if (!keys.length) return [];
  const permissions = await Permission.findAll({ where: { key: keys }, attributes: ['id', 'key'] });
  const found = new Set(permissions.map((p) => p.key));
  const unknown = keys.filter((k) => !found.has(k));
  if (unknown.length) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'permissionKeys', message: `Unknown permissions: ${unknown.join(', ')}` },
    ]);
  }
  if (!auth.permissions.includes('*')) {
    const notHeld = keys.filter((k) => !auth.permissions.includes(k));
    if (notHeld.length)
      throw AppError.forbidden(`You cannot grant permissions you do not have: ${notHeld.join(', ')}`);
  }
  return permissions;
}

async function assertUniqueSlug(auth, slug, exceptId) {
  const existing = await Role.findOne({ where: { companyId: auth.companyId, slug }, attributes: ['id'] });
  if (existing && String(existing.id) !== String(exceptId)) {
    throw AppError.conflict('Role already exists', [
      { field: 'name', message: 'A role with this name already exists' },
    ]);
  }
}

async function replacePermissions(roleId, permissions, transaction) {
  await RolePermission.destroy({ where: { roleId }, transaction });
  if (permissions.length) {
    await RolePermission.bulkCreate(
      permissions.map((p) => ({ roleId, permissionId: p.id })),
      { transaction },
    );
  }
}

export async function createRole(auth, { name, description, permissionKeys }) {
  const slug = slugify(name);
  await assertUniqueSlug(auth, slug);
  const permissions = await resolvePermissions(auth, permissionKeys);

  const role = await sequelize.transaction(async (transaction) => {
    const created = await Role.create(
      { companyId: auth.companyId, name, slug, description, createdBy: auth.userId, updatedBy: auth.userId },
      { transaction },
    );
    await replacePermissions(created.id, permissions, transaction);
    return created;
  });
  return getRole(auth, role.id);
}

function assertEditable(role) {
  if (role.isSystem) throw AppError.forbidden(`The ${role.name} role is built in and cannot be changed`);
}

export async function updateRole(auth, id, { name, description, permissionKeys }) {
  const role = await findRole(auth, id);
  assertEditable(role);

  const patch = { updatedBy: auth.userId };
  if (name !== undefined && name !== role.name) {
    patch.name = name;
    patch.slug = slugify(name);
    await assertUniqueSlug(auth, patch.slug, role.id);
  }
  if (description !== undefined) patch.description = description;
  const permissions = permissionKeys ? await resolvePermissions(auth, permissionKeys) : null;

  await sequelize.transaction(async (transaction) => {
    await role.update(patch, { transaction });
    if (permissions) await replacePermissions(role.id, permissions, transaction);
  });
  return getRole(auth, role.id);
}

export const setPermissions = (auth, id, permissionKeys) => updateRole(auth, id, { permissionKeys });

export async function deleteRole(auth, id) {
  const role = await findRole(auth, id);
  assertEditable(role);
  const assigned = await UserRole.count({ where: { roleId: role.id } });
  if (assigned) throw AppError.conflict(`This role is assigned to ${assigned} user(s). Reassign them first.`);

  await sequelize.transaction(async (transaction) => {
    await RolePermission.destroy({ where: { roleId: role.id }, transaction });
    await role.update(
      { slug: retiredValue(role.slug, role.id, 100), updatedBy: auth.userId },
      { transaction },
    );
    await role.destroy({ transaction });
  });
}
