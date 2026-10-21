import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as branchesService from './branches.service.js';

const router = Router();

/**
 * @openapi
 * /branches:
 *   get:
 *     tags: [Branches]
 *     summary: Active branches of the company (for assignment pickers)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Branches }
 */
router.get('/', authenticate, authorize('users.view', 'settings.view'), async (req, res) =>
  sendSuccess(res, { data: await branchesService.listBranches(req.auth) }),
);

export default router;
