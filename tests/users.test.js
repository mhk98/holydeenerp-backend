import { closeDatabase } from '../src/config/db.js';
import { api, bearer, DEMO_PASSWORD, login, uniqueEmail } from './helpers.js';

let admin;
let roles;
let branches;

beforeAll(async () => {
  admin = await login('admin@holydeen.com');
  roles = (await api().get('/api/v1/roles?limit=100').set(bearer(admin.token))).body.data;
  branches = (await api().get('/api/v1/branches').set(bearer(admin.token))).body.data;
});
afterAll(() => closeDatabase());

const roleId = (slug) => roles.find((r) => r.slug === slug).id;
const branchId = (code) => branches.find((b) => b.code === code).id;

const newUser = (overrides = {}) => ({
  name: 'Jannatul Ferdous',
  email: uniqueEmail('jannat'),
  phone: '+8801711998877',
  password: DEMO_PASSWORD,
  roleIds: [roleId('cashier')],
  branchIds: [branchId('HO'), branchId('CTG')],
  defaultBranchId: branchId('CTG'),
  ...overrides,
});

describe('GET /users', () => {
  it('paginates, searches, filters and sorts', async () => {
    const page = await api().get('/api/v1/users?page=1&limit=3&sort=name').set(bearer(admin.token));
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(3);
    expect(page.body.meta).toMatchObject({ page: 1, limit: 3 });
    expect(page.body.meta.total).toBeGreaterThanOrEqual(9);
    const names = page.body.data.map((u) => u.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    const search = await api().get('/api/v1/users?search=farzana').set(bearer(admin.token));
    expect(search.body.data.map((u) => u.email)).toEqual(['accountant@holydeen.com']);

    const inactive = await api().get('/api/v1/users?status=inactive').set(bearer(admin.token));
    expect(inactive.body.data.every((u) => u.status === 'inactive')).toBe(true);

    const cashiers = await api()
      .get(`/api/v1/users?roleId=${roleId('cashier')}`)
      .set(bearer(admin.token));
    expect(cashiers.body.data.length).toBeGreaterThanOrEqual(2);
    expect(cashiers.body.data.every((u) => u.roles.some((r) => r.slug === 'cashier'))).toBe(true);
  });

  it('never exposes password hashes or 2FA secrets', async () => {
    const res = await api().get('/api/v1/users').set(bearer(admin.token));
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/passwordHash|password_hash|twoFactorSecret|\$2b\$/);
  });

  it('is forbidden without users.view', async () => {
    const cashier = await login('cashier@holydeen.com');
    expect((await api().get('/api/v1/users').set(bearer(cashier.token))).status).toBe(403);
  });
});

describe('user CRUD', () => {
  it('creates, reads, updates and deletes a user', async () => {
    const body = newUser();
    const created = await api().post('/api/v1/users').set(bearer(admin.token)).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.roles.map((r) => r.slug)).toEqual(['cashier']);
    expect(created.body.data.branches.find((b) => b.isDefault).code).toBe('CTG');
    const { id } = created.body.data;

    const fetched = await api().get(`/api/v1/users/${id}`).set(bearer(admin.token));
    expect(fetched.body.data.email).toBe(body.email);

    const updated = await api()
      .patch(`/api/v1/users/${id}`)
      .set(bearer(admin.token))
      .send({ roleIds: [roleId('cashier'), roleId('store-keeper')], branchIds: [branchId('SYL')] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.roles.map((r) => r.slug).sort()).toEqual(['cashier', 'store-keeper']);
    expect(updated.body.data.branches.map((b) => b.code)).toEqual(['SYL']);

    expect((await api().delete(`/api/v1/users/${id}`).set(bearer(admin.token))).status).toBe(200);
    expect((await api().get(`/api/v1/users/${id}`).set(bearer(admin.token))).status).toBe(404);

    // The email is freed for reuse after deletion.
    expect(
      (
        await api()
          .post('/api/v1/users')
          .set(bearer(admin.token))
          .send({ ...body })
      ).status,
    ).toBe(201);
  });

  it('validates input and rejects duplicate emails', async () => {
    const invalid = await api()
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send({ name: 'X', email: 'bad', password: 'short', roleIds: [], branchIds: [] });
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['name', 'email', 'password', 'roleIds', 'branchIds']),
    );

    const dup = await api()
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser({ email: 'manager@holydeen.com' }));
    expect(dup.status).toBe(409);
  });

  it('deactivates a user and ends their sessions', async () => {
    const body = newUser();
    const { id } = (await api().post('/api/v1/users').set(bearer(admin.token)).send(body)).body.data;
    const session = await login(body.email);

    const res = await api()
      .patch(`/api/v1/users/${id}/status`)
      .set(bearer(admin.token))
      .send({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('inactive');
    expect((await api().get('/api/v1/auth/me').set(bearer(session.token))).status).toBe(401);
    expect(
      (await api().post('/api/v1/auth/login').send({ email: body.email, password: DEMO_PASSWORD })).status,
    ).toBe(403);
  });
});

describe('guards', () => {
  it('only a Super Admin can grant the Super Admin role or edit Super Admins', async () => {
    const grant = await api()
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser({ roleIds: [roleId('super-admin')] }));
    expect(grant.status).toBe(403);

    const list = await api().get('/api/v1/users?search=superadmin').set(bearer(admin.token));
    const superAdminId = list.body.data[0].id;
    const edit = await api()
      .patch(`/api/v1/users/${superAdminId}`)
      .set(bearer(admin.token))
      .send({ name: 'Hacked' });
    expect(edit.status).toBe(403);
  });

  it('prevents deleting or deactivating yourself', async () => {
    const me = admin.user.id;
    expect((await api().delete(`/api/v1/users/${me}`).set(bearer(admin.token))).status).toBe(400);
    expect(
      (await api().patch(`/api/v1/users/${me}/status`).set(bearer(admin.token)).send({ status: 'inactive' }))
        .status,
    ).toBe(400);
  });

  it('keeps at least one Super Admin', async () => {
    const sa = await login('superadmin@holydeen.com');
    const res = await api()
      .patch(`/api/v1/users/${sa.user.id}`)
      .set(bearer(sa.token))
      .send({ roleIds: [roleId('admin')] });
    expect(res.status).toBe(400);
  });

  it('rejects roles and branches from outside the company', async () => {
    const res = await api()
      .post('/api/v1/users')
      .set(bearer(admin.token))
      .send(newUser({ roleIds: ['999999'] }));
    expect(res.status).toBe(422);
  });
});
