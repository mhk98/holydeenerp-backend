import request from 'supertest';
import app from '../app.js';

export const DEMO_PASSWORD = 'Password@123';
export const api = () => request(app);

/** Pull the refresh cookie ("hd_rt=...") out of a response. */
export function refreshCookie(res) {
  const cookies = res.headers['set-cookie'] ?? [];
  return cookies.find((c) => c.startsWith('hd_rt='))?.split(';')[0];
}

/** Sign in and return { token, cookie, user, res }. */
export async function login(email, password = DEMO_PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${res.body.message}`);
  return { token: res.body.data.accessToken, cookie: refreshCookie(res), user: res.body.data.user, res };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
/** Unique email per test run so tests never collide. */
export const uniqueEmail = (prefix = 'user') => `${prefix}.${Date.now()}.${(counter += 1)}@test.holydeen.com`;
