import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { validate } from '../../middlewares/validate.js';
import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { createCrudRouter, ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams } from '../../utils/validation.js';
import { customerImport, supplierImport } from '../imports/definitions.js';
import { mountImportExport } from '../imports/import.routes.js';
import { customerGroups, customers, supplierGroups, suppliers } from './parties.service.js';
import * as v from './parties.validation.js';

/**
 * /customers (sales.*) and /suppliers (purchase.*) — two views over the same parties table.
 */
function partyRouter({ service, permission, basePath, tag, label, def }) {
  const router = Router();
  router.use(authenticate);
  const can = (action) => authorize(`${permission}.${action}`);

  mountImportExport(router, def, { permission, basePath, tag });

  router.get('/', can('view'), validate({ query: v.listPartyQuery }), async (req, res) => {
    const { rows, count, page, limit } = await service.list(ctxOf(req), req.validated.query);
    return sendPaginated(res, { rows, count }, { page, limit });
  });
  router.post('/', can('create'), validate({ body: v.partySchema }), async (req, res) =>
    sendCreated(res, await service.save(ctxOf(req), null, req.validated.body), `${label} created`),
  );
  router.get('/:id', can('view'), validate({ params: idParams }), async (req, res) =>
    sendSuccess(res, { data: await service.get(ctxOf(req), req.validated.params.id) }),
  );
  router.patch(
    '/:id',
    can('update'),
    validate({ params: idParams, body: v.updatePartySchema }),
    async (req, res) =>
      sendSuccess(res, {
        data: await service.save(ctxOf(req), req.validated.params.id, req.validated.body),
        message: `${label} updated`,
      }),
  );
  router.delete('/:id', can('delete'), validate({ params: idParams }), async (req, res) => {
    await service.remove(ctxOf(req), req.validated.params.id);
    return sendSuccess(res, { message: `${label} deleted` });
  });

  documentRoutes(basePath, tag, [
    {
      method: 'get',
      path: '',
      summary: `List ${label.toLowerCase()}s (filters: groupId, isActive)`,
      permission: `${permission}.view`,
      list: true,
    },
    {
      method: 'post',
      path: '',
      summary: `Create a ${label.toLowerCase()} with addresses (blank code = generated)`,
      permission: `${permission}.create`,
      body: v.partySchema,
    },
    {
      method: 'get',
      path: '/:id',
      summary: `Get a ${label.toLowerCase()}`,
      permission: `${permission}.view`,
    },
    {
      method: 'patch',
      path: '/:id',
      summary: `Update a ${label.toLowerCase()} (addresses replaced when sent)`,
      permission: `${permission}.update`,
      body: v.updatePartySchema,
    },
    {
      method: 'delete',
      path: '/:id',
      summary: `Delete (or drop the ${label.toLowerCase()} role of a party that has both roles)`,
      permission: `${permission}.delete`,
    },
  ]);
  return router;
}

export const customersRouter = partyRouter({
  service: customers,
  permission: 'sales',
  basePath: '/customers',
  tag: 'Customers',
  label: 'Customer',
  def: customerImport,
});
export const suppliersRouter = partyRouter({
  service: suppliers,
  permission: 'purchase',
  basePath: '/suppliers',
  tag: 'Suppliers',
  label: 'Supplier',
  def: supplierImport,
});

const groupRouter = (service, permission, basePath, tag, label) =>
  createCrudRouter({
    service,
    basePath,
    tag,
    label,
    permission,
    createSchema: v.groupSchema,
    updateSchema: v.updateGroupSchema,
  });

export const customerGroupsRouter = groupRouter(
  customerGroups,
  'sales',
  '/customer-groups',
  'Customers',
  'Customer group',
);
export const supplierGroupsRouter = groupRouter(
  supplierGroups,
  'purchase',
  '/supplier-groups',
  'Suppliers',
  'Supplier group',
);
