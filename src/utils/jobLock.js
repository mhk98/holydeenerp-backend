import { createHash } from 'node:crypto';
import { sequelize as defaultSequelize } from '../config/db.js';

/**
 * Run a scheduled job in at most one server process at a time. Two processes exist briefly on
 * every Hostinger deploy (old and new) or permanently if the app is set up twice; without this
 * both would fire the same cron tick — duplicate recurring invoices, reminder emails and backups.
 *
 * Uses a MySQL/MariaDB named lock held on its own connection, outside the request pool (a job may
 * run for minutes). Closing that session releases the lock, even if the process dies mid-job.
 *
 * @returns {Promise<{ ran: boolean, result?: unknown }>} ran=false when another process holds it.
 */
export async function withJobLock(name, work, { sequelize = defaultSequelize } = {}) {
  const manager = sequelize.connectionManager;
  const connection = await manager.connect(manager.config.replication?.write || manager.config);
  // The server may drop the idle session mid-job; without a listener that error crashes the process.
  connection.on?.('error', () => {});
  const dbHash = createHash('sha256').update(sequelize.getDatabaseName()).digest('hex').slice(0, 16);
  const lockName = `job:${name}:${dbHash}`.slice(0, 64);
  try {
    const rows = await new Promise((resolve, reject) => {
      connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName], (err, result) =>
        err ? reject(err) : resolve(result),
      );
    });
    if (Number(rows[0].acquired) !== 1) return { ran: false };
    return { ran: true, result: await work() };
  } finally {
    await manager.disconnect(connection).catch(() => connection.destroy?.());
  }
}
