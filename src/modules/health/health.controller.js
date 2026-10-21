import { sendSuccess } from '../../utils/apiResponse.js';
import * as healthService from './health.service.js';

export function liveness(req, res) {
  return sendSuccess(res, { data: healthService.getLiveness(), message: 'Service is running' });
}

export async function readiness(req, res) {
  const data = await healthService.getReadiness();
  const ready = data.status === 'ok';
  return res.status(ready ? 200 : 503).json({
    success: ready,
    message: ready ? 'Service is ready' : 'Service is not ready',
    data,
  });
}
