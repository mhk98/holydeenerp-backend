import app from './app.js';
import { env } from './src/config/env.js';
import { logger } from './src/config/logger.js';
import { connectDatabase, closeDatabase } from './src/config/db.js';
import { scheduleBackups, stopBackupSchedule } from './src/modules/backups/backups.scheduler.js';
import { scheduleSalesJobs, stopSalesJobs } from './src/modules/sales/sales.scheduler.js';

async function start() {
  try {
    await connectDatabase();
    await scheduleBackups().catch((err) => logger.error(`Backup scheduler not started: ${err.message}`));
    scheduleSalesJobs();
  } catch (err) {
    // Keep the API up so /api/v1/health/ready can report the outage; fail hard in production.
    logger.error(`Database connection failed: ${err.message}`);
    if (env.isProd) process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    logger.info(`${env.APP_NAME} API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    logger.info(`Swagger docs: http://localhost:${env.PORT}/api/docs`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
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
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.stack : reason });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { stack: err.stack });
  process.exit(1);
});

start()
