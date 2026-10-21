// Permission catalogue — single source for seeders (CommonJS) and the API (imported from ESM).
// Keys are "<module>.<action>", e.g. "sales.create".

const MODULES = [
  'dashboard',
  'products',
  'inventory',
  'purchase',
  'sales',
  'pos',
  'manufacturing',
  'assets',
  'accounting',
  'hr',
  'reports',
  'audit_logs',
  'settings',
  'users',
];

const ACTIONS = ['view', 'create', 'update', 'delete', 'approve', 'export', 'print'];

const ALL_PERMISSIONS = MODULES.flatMap((module) =>
  ACTIONS.map((action) => ({ module, action, key: `${module}.${action}` })),
);

const SUPER_ADMIN_SLUG = 'super-admin';

const ALL_BUT = (...excluded) => ACTIONS.filter((a) => !excluded.includes(a));
const OPERATIONS = [
  'dashboard',
  'products',
  'inventory',
  'purchase',
  'sales',
  'pos',
  'manufacturing',
  'assets',
  'accounting',
  'hr',
  'reports',
];

/** Default roles. `permissions` maps module → actions; "*" means every module and action. */
const DEFAULT_ROLES = [
  {
    slug: SUPER_ADMIN_SLUG,
    name: 'Super Admin',
    description: 'Unrestricted access to everything. Cannot be edited or deleted.',
    isSystem: true,
    permissions: '*',
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Full access to all modules of the company.',
    permissions: '*',
  },
  {
    slug: 'manager',
    name: 'Manager',
    description: 'Runs day-to-day operations; can approve but not delete.',
    permissions: {
      ...Object.fromEntries(OPERATIONS.map((m) => [m, ALL_BUT('delete')])),
      audit_logs: ['view'],
      settings: ['view'],
      users: ['view'],
    },
  },
  {
    slug: 'accountant',
    name: 'Accountant',
    description: 'Books, journals and financial reports.',
    permissions: {
      dashboard: ['view'],
      accounting: ACTIONS,
      reports: ['view', 'export', 'print'],
      sales: ['view', 'export', 'print'],
      purchase: ['view', 'export', 'print'],
      assets: ['view', 'export'],
    },
  },
  {
    slug: 'store-keeper',
    name: 'Store Keeper',
    description: 'Products, stock and goods receiving.',
    permissions: {
      dashboard: ['view'],
      products: ALL_BUT('delete', 'approve'),
      inventory: ALL_BUT('delete', 'approve'),
      purchase: ['view', 'create'],
      reports: ['view'],
    },
  },
  {
    slug: 'cashier',
    name: 'Cashier',
    description: 'Point of sale and counter sales.',
    permissions: {
      dashboard: ['view'],
      // pos.update (price changes, discounts above the POS limit) is for supervisors.
      pos: ['view', 'create', 'print'],
      sales: ['view', 'create', 'print'],
      products: ['view'],
    },
  },
  {
    slug: 'production-manager',
    name: 'Production Manager',
    description: 'Manufacturing orders, BOMs and production output.',
    permissions: {
      dashboard: ['view'],
      manufacturing: ALL_BUT('delete'),
      inventory: ['view', 'create', 'update'],
      products: ['view'],
      reports: ['view'],
    },
  },
];

/** Expand a role preset into permission keys. */
function presetKeys(permissions) {
  if (permissions === '*') return ALL_PERMISSIONS.map((p) => p.key);
  return Object.entries(permissions).flatMap(([module, actions]) => actions.map((a) => `${module}.${a}`));
}

module.exports = { MODULES, ACTIONS, ALL_PERMISSIONS, DEFAULT_ROLES, SUPER_ADMIN_SLUG, presetKeys };
