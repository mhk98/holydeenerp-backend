import { Router } from 'express';
import * as healthController from './health.controller.js';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness probe — the process is up
 *     responses:
 *       200:
 *         description: Service is running
 */
router.get('/', healthController.liveness);

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness probe — includes a database check
 *     responses:
 *       200:
 *         description: Service and database are reachable
 *       503:
 *         description: Database is unreachable
 */
router.get('/ready', healthController.readiness);

export default router;
