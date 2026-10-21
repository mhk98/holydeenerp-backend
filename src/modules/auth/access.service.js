import { Branch, Company, Permission, Role, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import catalog from '../roles/permission.catalog.cjs';

const { SUPER_ADMIN_SLUG } = catalog;

/**
 * Load everything authorisation needs for a user in one query:
 * roles → permissions, branches and company.
 */
export async function loadAccessContext(userId) {
  const user = await User.findByPk(userId, {
    include: [
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'code', 'currency', 'timezone', 'logoUrl', 'isActive'],
      },
      {
        model: Role,
        as: 'roles',
        attributes: ['id', 'name', 'slug', 'isSystem'],
        through: { attributes: [] },
        include: [{ model: Permission, as: 'permissions', attributes: ['key'], through: { attributes: [] } }],
      },
      {
        model: Branch,
        as: 'branches',
        attributes: ['id', 'name', 'code', 'isHeadOffice'],
        through: { attributes: ['isDefault'] },
        where: { isActive: true },
        required: false,
      },
    ],
  });
  if (!user) return null;

  const isSuperAdmin = user.roles.some((r) => r.slug === SUPER_ADMIN_SLUG);
  const permissions = isSuperAdmin
    ? ['*']
    : [...new Set(user.roles.flatMap((r) => r.permissions.map((p) => p.key)))].sort();

  // Super Admins can work in every active branch of their company.
  const branchRows = isSuperAdmin
    ? await Branch.findAll({
        where: { companyId: user.companyId, isActive: true },
        attributes: ['id', 'name', 'code', 'isHeadOffice'],
        order: [
          ['isHeadOffice', 'DESC'],
          ['name', 'ASC'],
        ],
      })
    : user.branches;

  const defaultBranchId = user.branches.find((b) => b.UserBranch?.isDefault)?.id ?? branchRows[0]?.id ?? null;
  const branches = branchRows.map((b) => ({
    id: String(b.id),
    name: b.name,
    code: b.code,
    isHeadOffice: b.isHeadOffice,
    isDefault: b.id === defaultBranchId,
  }));

  return {
    user,
    isSuperAdmin,
    permissions,
    branches,
    branchIds: branches.map((b) => b.id),
  };
}

export function hasPermission(ctx, required) {
  if (ctx.permissions.includes('*')) return true;
  const needed = Array.isArray(required) ? required : [required];
  return needed.some((p) => ctx.permissions.includes(p));
}

/** Public shape of the signed-in user (GET /auth/me, login, refresh). */
export function toSessionUser(ctx) {
  const { user } = ctx;
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    language: user.language,
    status: user.status,
    companyId: String(user.companyId),
    company: user.company && {
      id: String(user.company.id),
      name: user.company.name,
      code: user.company.code,
      currency: user.company.currency,
      timezone: user.company.timezone,
      logoUrl: user.company.logoUrl,
    },
    roles: user.roles.map((r) => ({ id: String(r.id), name: r.name, slug: r.slug })),
    permissions: ctx.permissions,
    branches: ctx.branches,
    isSuperAdmin: ctx.isSuperAdmin,
    twoFactorEnabled: user.twoFactorEnabled,
    lastLoginAt: user.lastLoginAt,
  };
}

/** Guard used by services: the user must exist, be active, and belong to an active company. */
export function assertCanSignIn(user) {
  if (user.status !== 'active')
    throw AppError.forbidden('Your account is inactive. Contact your administrator.');
  if (user.company && !user.company.isActive) throw AppError.forbidden('Your company account is inactive.');
}
