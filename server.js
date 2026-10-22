import app from './app.js';
import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { closeDatabase, connectDatabaseWithRetry, setDatabaseReady } from './src/config/db.js';
import { scheduleBackups, stopBackupSchedule } from './src/modules/backups/backups.scheduler.js';
import { scheduleSalesJobs, stopSalesJobs } from './src/modules/sales/sales.scheduler.js';

async function start() {
  let stopping = false;

  // Listen first so /api/v1/health/ready can report a database outage; other API calls answer
  // 503 until the database is reachable (src/middlewares/databaseReady.js).
  setDatabaseReady(false);
  const server = app.listen(env.PORT, () => {
    logger.info(`${env.APP_NAME} API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    if (env.API_DOCS_ENABLED) logger.info(`Swagger docs: http://localhost:${env.PORT}/api/docs`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    stopping = true;
    stopBackupSchedule();
    stopSalesJobs();
    server.close(async () => {
      await closeDatabase().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Never exit on a database error: the host would restart the process at once, over and over,
  // each time spending another MySQL connection attempt. Retry with backoff instead.
  const connected = await connectDatabaseWithRetry({ shouldStop: () => stopping });
  if (!connected || stopping) return;
  setDatabaseReady(true);

  await scheduleBackups().catch((err) => logger.error(`Backup scheduler not started: ${err.message}`));
  scheduleSalesJobs();
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.stack : reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { stack: err.stack });
  process.exit(1);
});

start();
