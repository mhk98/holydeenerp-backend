import { resetDatabase } from './resetDb.js';

/**
 * When tests ran against the development database (TEST_ALLOW_MAIN_DB=true), put it back to
 * clean demo data so test-created users/roles don't linger.
 */
export default async function globalTeardown() {
  const { env } = await import('../src/config/env.js');
  if (env.TEST_ALLOW_MAIN_DB && env.DB_DATABASE === env.DB_NAME) await resetDatabase();
}
