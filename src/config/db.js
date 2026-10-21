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
  pool: { max: env.DB_POOL_MAX, min: 0, acquire: 30000, idle: 10000 },
  dialectOptions: {
    // Keep DECIMAL/BIGINT as strings so money never passes through JS floats.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',
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
