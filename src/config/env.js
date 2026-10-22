import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(rootDir, '.env'), quiet: true });

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  APP_NAME: z.string().default('Holydeen ERP'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_NAME: z.string().default('holydeen_erp'),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_TIMEZONE: z.string().default('+06:00'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_LOGGING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  CORS_ORIGINS: csv,
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  LOG_DIR: z.string().default('logs'),

  /** Separate database for the test suite — tests refuse to run without it. */
  DB_NAME_TEST: z.string().optional(),
  /**
   * Explicit opt-in to run the (table-dropping) test suite against DB_NAME itself.
   * Only for a development database whose data may be wiped and re-seeded.
   */
  TEST_ALLOW_MAIN_DB: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** Public URL of the web app, used in emails (password reset links). */
  APP_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  /**
   * Swagger UI at /api/docs. Defaults to off in production: building the spec converts every
   * route's Zod schemas at boot and keeps the whole document in memory.
   */
  API_DOCS_ENABLED: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v === 'true')),
  /** 32-byte key as 64 hex chars — encrypts 2FA secrets at rest. */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 64 hex characters'),

  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_RESET_EXPIRES_MINUTES: z.coerce.number().int().positive().default(30),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Holydeen ERP'),
  MAIL_FROM_EMAIL: z.string().email().default('no-reply@holydeen.com'),

  UPLOAD_DIR: z.string().default('uploads'),
  /** Cloudinary for public images (avatars, logos, product photos). Unset → local UPLOAD_DIR. */
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('holydeen'),
  /** Where database backups are written. On shared hosting keep it outside the deployed app folder. */
  BACKUP_DIR: z.string().default('backups'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(2),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Logger depends on env, so this is the one place console output is unavoidable.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', z.prettifyError(parsed.error));
  process.exit(1);
}

const isProd = parsed.data.NODE_ENV === 'production';
const isTest = parsed.data.NODE_ENV === 'test';

// Tests drop every table, so they only touch the main database with an explicit opt-in.
const testDatabase = parsed.data.TEST_ALLOW_MAIN_DB
  ? parsed.data.DB_NAME_TEST || parsed.data.DB_NAME
  : parsed.data.DB_NAME_TEST;

if (isTest && (!testDatabase || (testDatabase === parsed.data.DB_NAME && !parsed.data.TEST_ALLOW_MAIN_DB))) {
  // eslint-disable-next-line no-console
  console.error(
    'Set DB_NAME_TEST to a separate, empty database before running tests ' +
      '(or TEST_ALLOW_MAIN_DB=true to let tests wipe and re-seed DB_NAME).',
  );
  process.exit(1);
}
if (isProd && parsed.data.TEST_ALLOW_MAIN_DB) {
  // eslint-disable-next-line no-console
  console.error('TEST_ALLOW_MAIN_DB must not be enabled in production.');
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  ROOT_DIR: rootDir,
  isProd,
  isTest,
  COOKIE_SECURE: parsed.data.COOKIE_SECURE ?? isProd,
  API_DOCS_ENABLED: parsed.data.API_DOCS_ENABLED ?? !isProd,
  /** Database actually used by this process. */
  DB_DATABASE: isTest ? testDatabase : parsed.data.DB_NAME,
});
