import cron from 'node-cron';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { runAutomaticReminders } from './reminders.service.js';
import { runDueSchedules } from './recurring.service.js';

/** Daily sales jobs in Bangladesh time: recurring invoices at 01:00, payment reminders at 09:00. */
const TIMEZONE = 'Asia/Dhaka';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());

let tasks = [];

export function stopSalesJobs() {
  tasks.forEach((t) => t.stop());
  tasks = [];
}

/** Start the jobs (never under tests — they call the run functions directly). */
export function scheduleSalesJobs() {
  stopSalesJobs();
  if (env.NODE_ENV === 'test') return;
  const job = (expression, name, fn) =>
    cron.schedule(
      expression,
      () =>
        fn(today())
          .then((n) => logger.info(`${name}: ${Array.isArray(n) ? n.length : n} done`))
          .catch((err) => logger.error(`${name} failed: ${err.message}`)),
      { timezone: TIMEZONE, noOverlap: true, name },
    );
  tasks = [
    job('0 1 * * *', 'recurring-invoices', runDueSchedules),
    job('0 9 * * *', 'payment-reminders', runAutomaticReminders),
  ];
  logger.info('Sales jobs scheduled: recurring invoices 01:00, payment reminders 09:00 (Asia/Dhaka)');
}
