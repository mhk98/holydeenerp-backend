import speakeasy from 'speakeasy';
import { closeDatabase } from '../src/config/db.js';
import { LoginHistory, RefreshToken, User } from '../src/models.js';
import { sha256 } from '../src/utils/crypto.js';
import { api, bearer, DEMO_PASSWORD, login, refreshCookie, uniqueEmail } from './helpers.js';

afterAll(() => closeDatabase());

/** Create a throwaway active user (Cashier, Head Office) through the API. */
async function createUser(adminToken, overrides = {}) {
  const roles = await api().get('/api/v1/roles?search=Cashier').set(bearer(adminToken));
  const branches = await api().get('/api/v1/branches').set(bearer(adminToken));
  const email = uniqueEmail();
  const res = await api()
    .post('/api/v1/users')
    .set(bearer(adminToken))
    .send({
      name: 'Test User',
      email,
      password: DEMO_PASSWORD,
      roleIds: [roles.body.data[0].id],
      branchIds: [branches.body.data[0].id],
      ...overrides,
    });
  expect(res.status).toBe(201);
  return { ...res.body.data, email };
}

describe('POST /auth/login', () => {
  it('signs in, returns the user with permissions and sets an httpOnly refresh cookie', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'admin@holydeen.com', password: DEMO_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ email: 'admin@holydeen.com', company: { code: 'HOLYDEEN' } });
    expect(res.body.data.user.permissions).toContain('users.create');
    expect(res.body.data.user.branches).toHaveLength(3);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hd_rt='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'manager@holydeen.com', password: 'nope1234' });
    const unknown = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@holydeen.com', password: 'nope1234' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('rejects inactive users', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'rakib.hasan@holydeen.com', password: DEMO_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('validates the body', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('locks the account for 15 minutes after 5 failed attempts and records login history', async () => {
    const { token } = await login('admin@holydeen.com');
    const user = await createUser(token);
    const attempt = (password) => api().post('/api/v1/auth/login').send({ email: user.email, password });

    for (let i = 0; i < 4; i += 1) expect((await attempt('wrong-pass1')).status).toBe(401);
    const fifth = await attempt('wrong-pass1');
    expect(fifth.status).toBe(423);

    // Even the right password is refused while locked.
    expect((await attempt(DEMO_PASSWORD)).status).toBe(423);

    const row = await User.findByPk(user.id);
    expect(row.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const history = await LoginHistory.findAll({ where: { userId: user.id } });
    expect(history.filter((h) => !h.success).length).toBeGreaterThanOrEqual(6);
    expect(history.some((h) => h.failureReason === 'locked')).toBe(true);

    // Activating the user again clears the lock.
    await api().patch(`/api/v1/users/${user.id}/status`).set(bearer(token)).send({ status: 'active' });
    expect((await attempt(DEMO_PASSWORD)).status).toBe(200);
  });
});

describe('GET /auth/me', () => {
  it('requires a bearer token', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('returns "*" for a Super Admin and scoped permissions for others', async () => {
    const sa = await login('superadmin@holydeen.com');
    const cashier = await login('cashier@holydeen.com');

    const saMe = await api().get('/api/v1/auth/me').set(bearer(sa.token));
    const cashierMe = await api().get('/api/v1/auth/me').set(bearer(cashier.token));

    expect(saMe.body.data.permissions).toEqual(['*']);
    expect(cashierMe.body.data.permissions).toEqual(expect.arrayContaining(['pos.create', 'sales.view']));
    expect(cashierMe.body.data.permissions).not.toContain('users.view');
    expect(cashierMe.body.data.branches.map((b) => b.code)).toEqual(['CTG']);
  });
});

describe('refresh token rotation', () => {
  it('rotates the cookie and detects reuse of an old token', async () => {
    const { cookie } = await login('manager@holydeen.com');

    const first = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);
    const rotated = refreshCookie(first);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(cookie);

    // Move the old token's revocation outside the grace window, then replay it.
    const oldHash = sha256(decodeURIComponent(cookie.split('=')[1]));
    await RefreshToken.update(
      { revokedAt: new Date(Date.now() - 60_000) },
      { where: { tokenHash: oldHash } },
    );
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);

    // Reuse revoked the whole family, so the new token is dead too.
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', rotated)).status).toBe(401);
  });

  it('fails without a cookie and after logout', async () => {
    expect((await api().post('/api/v1/auth/refresh')).status).toBe(401);

    const { cookie, token } = await login('accountant@holydeen.com');
    expect((await api().post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(200);
    expect((await api().post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    // The access token of an ended session stops working immediately.
    expect((await api().get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe('passwords', () => {
  it('changes the password and signs out other sessions', async () => {
    const { token: adminToken } = await login('admin@holydeen.com');
    const user = await createUser(adminToken);
    const deviceA = await login(user.email);
    const deviceB = await login(user.email);

    const bad = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(deviceA.token))
      .send({ currentPassword: 'wrong', newPassword: 'NewPass123' });
    expect(bad.status).toBe(422);

    const ok = await api()
      .post('/api/v1/auth/change-password')
      .set(bearer(deviceA.token))
      .send({ currentPassword: DEMO_PASSWORD, newPassword: 'NewPass123' });
    expect(ok.status).toBe(200);

    expect((await api().get('/api/v1/auth/me').set(bearer(deviceA.token))).status).toBe(200);
    expect((await api().get('/api/v1/auth/me').set(bearer(deviceB.token))).status).toBe(401);
    expect((await login(user.email, 'NewPass123')).token).toBeDefined();
  });

  it('runs the forgot / reset flow', async () => {
    const { token: adminToken } = await login('admin@holydeen.com');
    const user = await createUser(adminToken);

    const forgot = await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    expect(forgot.status).toBe(200);
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'nobody@holydeen.com' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.message).toBe(forgot.body.message);

    const stored = await User.scope('withSecrets').findByPk(user.id);
    expect(stored.passwordResetTokenHash).toHaveLength(64);

    // The emailed token is never stored in plain text, so plant a known one.
    const token = 'known-reset-token-for-tests-0123456789';
    await stored.update({ passwordResetTokenHash: sha256(token) });

    expect((await api().get(`/api/v1/auth/reset-password/${token}`)).status).toBe(200);
    const weak = await api().post('/api/v1/auth/reset-password').send({ token, password: 'short' });
    expect(weak.status).toBe(422);
    const reset = await api().post('/api/v1/auth/reset-password').send({ token, password: 'ResetPass99' });
    expect(reset.status).toBe(200);

    // Token is single use.
    expect((await api().get(`/api/v1/auth/reset-password/${token}`)).status).toBe(400);
    expect((await login(user.email, 'ResetPass99')).token).toBeDefined();
  });
});

describe('two-factor authentication', () => {
  it('sets up, enforces at login, and disables 2FA', async () => {
    const { token: adminToken } = await login('admin@holydeen.com');
    const user = await createUser(adminToken);
    const { token } = await login(user.email);

    const setup = await api().post('/api/v1/auth/2fa/setup').set(bearer(token));
    expect(setup.status).toBe(200);
    expect(setup.body.data.qrCode).toMatch(/^data:image\/png;base64,/);
    const { secret } = setup.body.data;
    const code = () => speakeasy.totp({ secret, encoding: 'base32' });

    expect(
      (await api().post('/api/v1/auth/2fa/enable').set(bearer(token)).send({ code: '000000' })).status,
    ).toBe(422);
    expect(
      (await api().post('/api/v1/auth/2fa/enable').set(bearer(token)).send({ code: code() })).status,
    ).toBe(200);

    const step1 = await api().post('/api/v1/auth/login').send({ email: user.email, password: DEMO_PASSWORD });
    expect(step1.status).toBe(200);
    expect(step1.body.data).toMatchObject({ requiresTwoFactor: true });
    expect(step1.body.data.accessToken).toBeUndefined();

    const { challengeToken } = step1.body.data;
    const badCode = await api().post('/api/v1/auth/login/2fa').send({ challengeToken, code: '000000' });
    expect(badCode.status).toBe(401);
    const step2 = await api().post('/api/v1/auth/login/2fa').send({ challengeToken, code: code() });
    expect(step2.status).toBe(200);
    expect(step2.body.data.user.twoFactorEnabled).toBe(true);

    const disable = await api()
      .post('/api/v1/auth/2fa/disable')
      .set(bearer(step2.body.data.accessToken))
      .send({ password: DEMO_PASSWORD, code: code() });
    expect(disable.status).toBe(200);
  });
});

describe('sessions', () => {
  it('lists sessions and signs out other devices', async () => {
    const { token: adminToken } = await login('admin@holydeen.com');
    const user = await createUser(adminToken);
    const laptop = await login(user.email);
    const phone = await login(user.email);

    const list = await api().get('/api/v1/auth/sessions').set(bearer(laptop.token));
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);

    expect((await api().post('/api/v1/auth/sessions/revoke-others').set(bearer(laptop.token))).status).toBe(
      200,
    );
    expect((await api().get('/api/v1/auth/me').set(bearer(phone.token))).status).toBe(401);
    expect((await api().get('/api/v1/auth/sessions').set(bearer(laptop.token))).body.data).toHaveLength(1);
  });

  it('updates the profile', async () => {
    const { token } = await login('storekeeper@holydeen.com');
    const res = await api()
      .patch('/api/v1/auth/profile')
      .set(bearer(token))
      .send({ name: 'Abdul Karim Mia', phone: '+8801612987345', language: 'bn' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Abdul Karim Mia', language: 'bn' });
  });
});
