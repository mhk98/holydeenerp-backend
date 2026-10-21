import { env } from '../../config/env.js';
import { checkDatabase } from '../../config/db.js';

export function getLiveness() {
  return {
    status: 'ok',
    app: env.APP_NAME,
    env: env.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

export async function getReadiness() {
  const database = await checkDatabase();
  return {
    ...getLiveness(),
    status: database.status === 'up' ? 'ok' : 'degraded',
    checks: { database },
  };
}
