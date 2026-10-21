import { closeDatabase } from '../src/config/db.js';
import { branchScope } from '../src/middlewares/rbac.js';
import { api, bearer, DEMO_PASSWORD, login, uniqueEmail } from './helpers.js';

let admin;

beforeAll(async () => {
  admin = await login('admin@holydeen.com');
});
afterAll(() => closeDatabase());

const findRole = async (slug) =>
  (await api().get('/api/v1/roles?limit=100').set(bearer(admin.token))).body.data.find(
    (r) => r.slug === slug,
  );

describe('permission catalogue', () => {
  it('lists 14 modules × 7 actions', async () => {
    const res = await api().get('/api/v1/roles/permissions').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.modules).toHaveLength(14);
    expect(res.body.data.actions).toEqual([
      'view',
      'create',
      'update',
      'delete',
      'approve',
      'export',
      'print',
    ]);
    expect(res.body.data.permissions).toHaveLength(98);
  });
});

describe('roles', () => {
  it('seeds the seven default roles', async () => {
    const res = await api().get('/api/v1/roles?limit=100').set(bearer(admin.token));
    expect(res.body.data.map((r) => r.name).sort()).toEqual(
      [
        'Accountant',
        'Admin',
        'Cashier',
        'Manager',
        'Production Manager',
        'Store Keeper',
        'Super Admin',
      ].sort(),
    );
    const superAdmin = res.body.data.find((r) => r.slug === 'super-admin');
    expect(superAdmin).toMatchObject({ isSystem: true, permissionsCount: 98 });
  });

  it('creates a role, saves the permission matrix and deletes it', async () => {
    const created = await api()
      .post('/api/v1/roles')
      .set(bearer(admin.token))
      .send({ name: 'Sales Executive', description: 'Field sales team', permissionKeys: ['sales.view'] });
    expect(created.status).toBe(201);
    expect(created.body.data.permissionKeys).toEqual(['sales.view']);
    const { id } = created.body.data;

    const dup = await api().post('/api/v1/roles').set(bearer(admin.token)).send({ name: 'Sales Executive' });
    expect(dup.status).toBe(409);

    const matrix = await api()
      .put(`/api/v1/roles/${id}/permissions`)
      .set(bearer(admin.token))
      .send({ permissionKeys: ['sales.view', 'sales.create', 'sales.print', 'products.view'] });
    expect(matrix.status).toBe(200);
    expect(matrix.body.data.permissionKeys).toEqual([
      'products.view',
      'sales.create',
      'sales.print',
      'sales.view',
    ]);

    const unknown = await api()
      .put(`/api/v1/roles/${id}/permissions`)
      .set(bearer(admin.token))
      .send({ permissionKeys: ['sales.fly'] });
    expect(unknown.status).toBe(422);

    expect((await api().delete(`/api/v1/roles/${id}`).set(bearer(admin.token))).status).toBe(200);
    // The name can be reused once deleted.
    expect(
      (await api().post('/api/v1/roles').set(bearer(admin.token)).send({ name: 'Sales Executive' })).status,
    ).toBe(201);
  });

  it('protects the Super Admin role and roles that are in use', async () => {
    const superAdmin = await findRole('super-admin');
    const sa = await login('superadmin@holydeen.com');
    expect(
      (
        await api()
          .put(`/api/v1/roles/${superAdmin.id}/permissions`)
          .set(bearer(sa.token))
          .send({ permissionKeys: [] })
      ).status,
    ).toBe(403);
    expect((await api().delete(`/api/v1/roles/${superAdmin.id}`).set(bearer(sa.token))).status).toBe(403);

    const cashier = await findRole('cashier');
    expect((await api().delete(`/api/v1/roles/${cashier.id}`).set(bearer(admin.token))).status).toBe(409);
  });

  it('does not let users grant permissions they do not hold', async () => {
    // A role that may manage users/roles but has nothing in accounting.
    const lead = await api()
      .post('/api/v1/roles')
      .set(bearer(admin.token))
      .send({
        name: `HR Lead ${Date.now()}`,
        permissionKeys: ['users.view', 'users.create', 'users.update', 'hr.view'],
      });
    const branches = (await api().get('/api/v1/branches').set(bearer(admin.token))).body.data;
    const email = uniqueEmail('hrlead');
    await api()
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send({
        name: 'HR Lead',
        email,
        password: DEMO_PASSWORD,
        roleIds: [lead.body.data.id],
        branchIds: [branches[0].id],
      });
    const hr = await login(email);

    const allowed = await api()
      .post('/api/v1/roles')
      .set(bearer(hr.token))
      .send({ name: `HR Assistant ${Date.now()}`, permissionKeys: ['hr.view'] });
    expect(allowed.status).toBe(201);

    const escalate = await api()
      .put(`/api/v1/roles/${allowed.body.data.id}/permissions`)
      .set(bearer(hr.token))
      .send({ permissionKeys: ['hr.view', 'accounting.view'] });
    expect(escalate.status).toBe(403);
  });

  it('requires users.* permissions', async () => {
    const accountant = await login('accountant@holydeen.com');
    expect((await api().get('/api/v1/roles').set(bearer(accountant.token))).status).toBe(403);
  });
});

describe('branchScope middleware', () => {
  const run = (headers, branchIds) => {
    const req = { auth: { branchIds }, get: (h) => headers[h.toLowerCase()] };
    let error;
    try {
      branchScope(req, {}, () => {});
    } catch (err) {
      error = err;
    }
    return { req, error };
  };

  it('defaults to all of the user branches', () => {
    const { req } = run({}, ['1', '2']);
    expect(req.branchId).toBeNull();
    expect(req.branchIds).toEqual(['1', '2']);
  });

  it('accepts an assigned branch and rejects others', () => {
    expect(run({ 'x-branch-id': '2' }, ['1', '2']).req.branchIds).toEqual(['2']);
    expect(run({ 'x-branch-id': '3' }, ['1', '2']).error.statusCode).toBe(403);
  });
});
