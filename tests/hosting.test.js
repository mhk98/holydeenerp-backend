import request from 'supertest';
import app from '../app.js';
import { closeDatabase, connectDatabaseWithRetry, setDatabaseReady } from '../src/config/db.js';
import { withJobLock } from '../src/utils/jobLock.js';
import { env } from '../src/config/env.js';

afterAll(async () => {
  setDatabaseReady(true);
  await closeDatabase();
});

/** A fake Sequelize whose lock connection answers GET_LOCK with `acquired`. */
function lockSequelize(acquired, { failDisconnect = false } = {}) {
  const state = { connects: 0, queries: [], disconnected: false, destroyed: false, errorHandler: null };
  const connection = {
    on(event, handler) {
      state.errorHandler = handler;
    },
    query(sql, params, callback) {
      state.queries.push({ sql, params });
      callback(null, [{ acquired }]);
    },
    destroy() {
      state.destroyed = true;
    },
  };
  const sequelize = {
    getDatabaseName: () => 'erp_test',
    connectionManager: {
      config: { replication: false, host: 'db' },
      async connect(config) {
        expect(config.host).toBe('db');
        state.connects += 1;
        return connection;
      },
      async disconnect(c) {
        expect(c).toBe(connection);
        if (failDisconnect) throw new Error('already closed');
        state.disconnected = true;
      },
      getConnection: async () => {
        throw new Error('the job lock must not take a pooled connection');
      },
    },
  };
  return { sequelize, state };
}

describe('Scheduled job lock', () => {
  it('runs the job when the lock is free and always closes its own connection', async () => {
    const { sequelize, state } = lockSequelize(1);
    const outcome = await withJobLock('recurring-invoices', async () => 3, { sequelize });

    expect(outcome).toEqual({ ran: true, result: 3 });
    expect(state.connects).toBe(1);
    expect(state.queries[0].sql).toBe('SELECT GET_LOCK(?, 0) AS acquired');
    expect(state.queries[0].params[0]).toMatch(/^job:recurring-invoices:[0-9a-f]{16}$/);
    expect(state.disconnected).toBe(true);
    expect(typeof state.errorHandler).toBe('function');
  });

  it('skips the job when another process holds the lock', async () => {
    const { sequelize, state } = lockSequelize(0);
    let calls = 0;
    const outcome = await withJobLock('payment-reminders', async () => (calls += 1), { sequelize });

    expect(outcome).toEqual({ ran: false });
    expect(calls).toBe(0);
    expect(state.disconnected).toBe(true);
  });

  it('releases the lock (closes the session) when the job fails', async () => {
    const { sequelize, state } = lockSequelize(1);
    await expect(
      withJobLock(
        'database-backup',
        async () => {
          throw new Error('disk full');
        },
        { sequelize },
      ),
    ).rejects.toThrow('disk full');
    expect(state.disconnected).toBe(true);
  });

  it('destroys the session if a clean close fails', async () => {
    const { sequelize, state } = lockSequelize(1, { failDisconnect: true });
    await withJobLock('database-backup', async () => null, { sequelize });
    expect(state.destroyed).toBe(true);
  });
});

describe('Database connection retry', () => {
  it('keeps retrying with backoff instead of giving up', async () => {
    const waits = [];
    let attempts = 0;
    const connected = await connectDatabaseWithRetry({
      connect: async () => {
        attempts += 1;
        if (attempts < 6) throw new Error('ECONNREFUSED');
      },
      delays: [10, 20, 40],
      wait: async (ms) => waits.push(ms),
    });

    expect(connected).toBe(true);
    expect(attempts).toBe(6);
    expect(waits).toEqual([10, 20, 40, 40, 40]);
  });

  it('stops waiting when the server is shutting down', async () => {
    let stopping = false;
    const connected = await connectDatabaseWithRetry({
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
      delays: [10],
      wait: async () => {
        stopping = true;
      },
      shouldStop: () => stopping,
    });

    expect(connected).toBe(false);
  });
});

describe('API while the database is still connecting', () => {
  afterEach(() => setDatabaseReady(true));

  it('answers 503 with Retry-After for API calls', async () => {
    setDatabaseReady(false);
    const res = await request(app).get('/api/v1/products');

    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toMatchObject({ success: false });
  });

  it('keeps the health endpoints reachable', async () => {
    setDatabaseReady(false);
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
  });

  it('serves API calls normally once connected', async () => {
    setDatabaseReady(true);
    const res = await request(app).get('/api/v1/products');

    // Not 503: the request reaches the router (401 because no token is sent).
    expect(res.status).toBe(401);
  });
});

describe('CORS preflight', () => {
  it('lets browsers cache the preflight for whitelisted origins', async () => {
    const origin = env.CORS_ORIGINS[0];
    const res = await request(app)
      .options('/api/v1/products')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-max-age']).toBe('7200');
  });
});
