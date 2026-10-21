import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { idParams } from '../../utils/validation.js';
import * as c from './roles.controller.js';
import * as v from './roles.validation.js';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   - name: Roles
 *     description: Roles and their permission matrix. Managed with the users.* permissions.
 * components:
 *   schemas:
 *     RoleInput:
 *       type: object
 *       required: [name]
 *       properties:
 *         name: { type: string, example: Sales Executive }
 *         description: { type: string }
 *         permissionKeys: { type: array, items: { type: string }, example: ['sales.view', 'sales.create'] }
 */

/**
 * @openapi
 * /roles/permissions:
 *   get:
 *     tags: [Roles]
 *     summary: Permission catalogue (modules × actions) for building the matrix
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: '{ modules, actions, permissions }' }
 */
router.get('/permissions', authorize('users.view'), c.catalog);

/**
 * @openapi
 * /roles:
 *   get:
 *     tags: [Roles]
 *     summary: List roles with user and permission counts
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: sort, schema: { type: string, example: name } }
 *     responses:
 *       200: { description: Roles }
 *   post:
 *     tags: [Roles]
 *     summary: Create a role
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/RoleInput' } } }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Name already used }
 */
router.get('/', authorize('users.view'), c.list);
router.post('/', authorize('users.create'), validate({ body: v.createRoleSchema }), c.create);

/**
 * @openapi
 * /roles/{id}:
 *   parameters:
 *     - { in: path, name: id, required: true, schema: { type: string } }
 *   get:
 *     tags: [Roles]
 *     summary: Get a role with its permission keys
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Role }
 *   patch:
 *     tags: [Roles]
 *     summary: Update name/description (and optionally permissions)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/RoleInput' } } }
 *     responses:
 *       200: { description: Updated }
 *       403: { description: Built-in role }
 *   delete:
 *     tags: [Roles]
 *     summary: Delete a role that has no users
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Deleted }
 *       409: { description: Role still assigned }
 * /roles/{id}/permissions:
 *   put:
 *     tags: [Roles]
 *     summary: Replace the role's permissions (permission matrix save)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [permissionKeys], properties: { permissionKeys: { type: array, items: { type: string } } } }
 *     responses:
 *       200: { description: Saved }
 */
router.get('/:id', authorize('users.view'), validate({ params: idParams }), c.get);
router.patch(
  '/:id',
  authorize('users.update'),
  validate({ params: idParams, body: v.updateRoleSchema }),
  c.update,
);
router.put(
  '/:id/permissions',
  authorize('users.update'),
  validate({ params: idParams, body: v.setPermissionsSchema }),
  c.setPermissions,
);
router.delete('/:id', authorize('users.delete'), validate({ params: idParams }), c.remove);

export default router;
