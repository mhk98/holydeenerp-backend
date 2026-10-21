import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { idParams } from '../../utils/validation.js';
import * as c from './users.controller.js';
import * as v from './users.validation.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: User accounts of the signed-in user's company
 * components:
 *   schemas:
 *     UserInput:
 *       type: object
 *       required: [name, email, password, roleIds, branchIds]
 *       properties:
 *         name: { type: string, example: Rahim Uddin }
 *         email: { type: string, example: rahim@holydeen.com }
 *         phone: { type: string, example: '+8801711000000' }
 *         password: { type: string, description: 'Required on create; optional on update' }
 *         status: { type: string, enum: [active, inactive] }
 *         language: { type: string, enum: [en, bn] }
 *         roleIds: { type: array, items: { type: string } }
 *         branchIds: { type: array, items: { type: string } }
 *         defaultBranchId: { type: string }
 */

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List users (paginated)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: sort, schema: { type: string, example: '-createdAt' }, description: 'name, email, status, lastLoginAt, createdAt' }
 *       - { in: query, name: search, schema: { type: string }, description: 'Name, email or phone' }
 *       - { in: query, name: status, schema: { type: string, enum: [active, inactive] } }
 *       - { in: query, name: roleId, schema: { type: string } }
 *       - { in: query, name: branchId, schema: { type: string } }
 *     responses:
 *       200: { description: Users with pagination meta }
 *   post:
 *     tags: [Users]
 *     summary: Create a user
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/UserInput' } } }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Email already in use }
 *       422: { description: Validation failed }
 */
router.get('/', authorize('users.view'), validate({ query: v.listUsersQuery }), c.list);
router.post('/', authorize('users.create'), validate({ body: v.createUserSchema }), c.create);

/**
 * @openapi
 * /users/{id}:
 *   parameters:
 *     - { in: path, name: id, required: true, schema: { type: string } }
 *   get:
 *     tags: [Users]
 *     summary: Get a user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: User }
 *       404: { description: Not found }
 *   patch:
 *     tags: [Users]
 *     summary: Update a user (send only changed fields; password optional)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/UserInput' } } }
 *     responses:
 *       200: { description: Updated }
 *   delete:
 *     tags: [Users]
 *     summary: Delete a user (soft delete; signs out all sessions)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deleted }
 * /users/{id}/status:
 *   patch:
 *     tags: [Users]
 *     summary: Activate or deactivate a user (activation also clears a lockout)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [status], properties: { status: { type: string, enum: [active, inactive] } } }
 *     responses:
 *       200: { description: Updated }
 */
router.get('/:id', authorize('users.view'), validate({ params: idParams }), c.get);
router.patch(
  '/:id',
  authorize('users.update'),
  validate({ params: idParams, body: v.updateUserSchema }),
  c.update,
);
router.patch(
  '/:id/status',
  authorize('users.update'),
  validate({ params: idParams, body: v.updateStatusSchema }),
  c.setStatus,
);
router.delete('/:id', authorize('users.delete'), validate({ params: idParams }), c.remove);

export default router;
