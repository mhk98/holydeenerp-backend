import cron from 'node-cron';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getSettings } from '../settings/settings.service.js';
import { createBackup, pruneScheduled } from './backups.service.js';

/** Schedule times are entered in Bangladesh time, whatever the server's own zone is. */
const TIMEZONE = 'Asia/Dhaka';

let task = null;

/** "HH:mm" + daily/weekly → cron expression, e.g. weekly 03:15 on Friday → "15 3 * * 5". */
export function cronExpression({ frequency, time, weekday }) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * ${frequency === 'weekly' ? weekday : '*'}`;
}

export function stopBackupSchedule() {
  task?.stop();
  task = null;
}

async function runScheduled() {
  const { retention } = await getSettings(null, 'backup');
  const backup = await createBackup({ type: 'scheduled' });
  const pruned = await pruneScheduled(retention);
  logger.info(`Scheduled backup ${backup.fileName} completed${pruned ? `, ${pruned} old removed` : ''}`);
}

/**
 * (Re)start the backup job from the saved settings. Returns the cron expression,
 * or null when scheduling is off. Never runs under tests.
 */
export async function scheduleBackups() {
  stopBackupSchedule();
  const settings = await getSettings(null, 'backup');
  if (!settings.scheduleEnabled) return null;

  const expression = cronExpression(settings);
  if (env.NODE_ENV !== 'test') {
    task = cron.schedule(
      expression,
      () => runScheduled().catch((err) => logger.error(`Scheduled backup failed: ${err.message}`)),
      { timezone: TIMEZONE, noOverlap: true, name: 'database-backup' },
    );
    logger.info(`Backup schedule: "${expression}" (${TIMEZONE})`);
  }
  return expression;
}
