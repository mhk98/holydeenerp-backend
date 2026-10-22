import { Sequelize } from 'sequelize';
import { env } from './env.js';
import { logger } from './logger.js';

export const sequelize = new Sequelize(env.DB_DATABASE, env.DB_USER, env.DB_PASSWORD, {
  host: env.DB_HOST,
  port: env.DB_PORT,
  dialect: 'mysql',
  timezone: env.DB_TIMEZONE,
  logging: env.DB_LOGGING ? (sql) => logger.debug(sql) : false,
  benchmark: env.DB_LOGGING,
  // Keep a few connections open: opening one to a remote database costs several round trips.
  pool: {
    max: env.DB_POOL_MAX,
    min: Math.min(env.DB_POOL_MIN, env.DB_POOL_MAX),
    acquire: 30000,
    idle: 60000,
  },
  dialectOptions: {
    // Keep DECIMAL/BIGINT as strings so money never passes through JS floats.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
    // Stop idle pooled connections from being dropped by NAT / proxies between the API and the DB.
    enableKeepAlive: true,
  },
  define: {
    underscored: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
});

export async function connectDatabase() {
  await sequelize.authenticate();
  logger.info(`Database connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_DATABASE}`);
}

/**
 * False only while server.js is still connecting at boot (see requireDatabase); an app imported
 * directly, as in tests, is always ready.
 */
let databaseReady = true;
export const isDatabaseReady = () => databaseReady;
export const setDatabaseReady = (value) => {
  databaseReady = value;
};

const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];

/**
 * Connect, retrying with backoff instead of exiting. On Hostinger a process that exits is restarted
 * at once, and each restart spends another MySQL connection attempt (max_connections_per_hour).
 * Resolves true once connected, or false if `shouldStop()` turns true while waiting.
 */
export async function connectDatabaseWithRetry({
  connect = connectDatabase,
  delays = RETRY_DELAYS_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldStop = () => false,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect();
      return true;
    } catch (err) {
      const delay = delays[Math.min(attempt, delays.length - 1)];
      logger.error(`Database connection failed: ${err.message}. Retrying in ${delay / 1000}s`);
      await wait(delay);
      if (shouldStop()) return false;
    }
  }
}

export async function checkDatabase() {
  const started = Date.now();
  try {
    await sequelize.query('SELECT 1');
    return { status: 'up', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', error: env.isProd ? undefined : err.message };
  }
}

export async function closeDatabase() {
  await sequelize.close();
}
