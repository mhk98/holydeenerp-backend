import { execSync } from 'node:child_process';
import { Sequelize } from 'sequelize';

/**
 * Rebuild the test database from scratch: drop every table, then run all migrations and seeders.
 * env.js decides which database that is (DB_NAME_TEST, or DB_NAME with TEST_ALLOW_MAIN_DB=true).
 */
export async function resetDatabase() {
  process.env.NODE_ENV = 'test';
  const { env } = await import('../src/config/env.js');

  // Own single-connection instance: the shared one from db.js may already be closed (setup and
  // teardown share the module cache), and FOREIGN_KEY_CHECKS only applies to one connection.
  const sequelize = new Sequelize(env.DB_DATABASE, env.DB_USER, env.DB_PASSWORD, {
    host: env.DB_HOST,
    port: env.DB_PORT,
    dialect: 'mysql',
    logging: false,
    pool: { max: 1, min: 1 },
  });

  const [tables] = await sequelize.query('SHOW TABLES');
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const row of tables) {
    const table = Object.values(row)[0];
    await sequelize.query(`DROP TABLE IF EXISTS \`${table.replace(/`/g, '')}\``);
  }
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  await sequelize.close();

  const run = (cmd) =>
    execSync(`npx sequelize-cli ${cmd}`, {
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'test', DB_NAME_TEST: env.DB_DATABASE },
    });
  run('db:migrate');
  run('db:seed:all');
  return env;
}
