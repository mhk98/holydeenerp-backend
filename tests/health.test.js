import request from 'supertest';
import app from '../app.js';
import { closeDatabase } from '../src/config/db.js';

afterAll(async () => {
  await closeDatabase();
});

describe('Health endpoints', () => {
  it('GET /api/v1/health returns the standard success envelope', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Service is running',
      data: { status: 'ok' },
    });
  });

  it('GET /api/v1/health/ready reports database status', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    // 200 when MySQL is reachable, 503 otherwise — the shape is the same.
    expect([200, 503]).toContain(res.status);
    expect(['up', 'down']).toContain(res.body.data.checks.database.status);
    expect(res.body.success).toBe(res.status === 200);
  });

  it('returns a 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      message: 'Route not found: GET /api/v1/does-not-exist',
    });
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
