import { resetDatabase } from './resetDb.js';

/** Start every run from a freshly migrated and seeded database. */
export default async function globalSetup() {
  await resetDatabase();
}
