import { Router } from 'express';
import { Op } from 'sequelize';
import { sequelize } from '../config/db.js';
import { authenticate } from '../middlewares/auth.js';
import { authorize, branchScope } from '../middlewares/rbac.js';
import { validate } from '../middlewares/validate.js';
import { AppError } from './AppError.js';
import { sendCreated, sendPaginated, sendSuccess } from './apiResponse.js';
import { documentRoutes } from './docs.js';
import { parseListQuery } from './pagination.js';
import { retiredValue } from './slug.js';
import { idParams } from './validation.js';

/**
 * Service for a simple tenant-scoped resource (list/get/create/update/delete).
 * Hooks let a resource add its own rules without re-implementing the plumbing.
 *
 * @param {object}   cfg
 * @param {import('sequelize').ModelStatic<any>} cfg.model
 * @param {string}   cfg.label            Human name for messages ("Warehouse")
 * @param {object}   cfg.listOptions      parseListQuery options (sortable/searchable/filterable/defaultSort)
 * @param {string[]} [cfg.uniqueFields]   Unique per company (e.g. ['code']); freed on delete
 * @param {Function} [cfg.uniqueScope]    (ctx) => extra where for the uniqueness check
 * @param {Function} [cfg.include]        () => Sequelize include for list/get
 * @param {Function} [cfg.scopeWhere]     (ctx) => visibility where, ANDed into every query (e.g. user's branches)
 * @param {Function} [cfg.beforeSave]     async (ctx, data, existing|null, t) => data
 * @param {Function} [cfg.afterSave]      async (ctx, record, data, t) => void
 * @param {Function} [cfg.beforeDelete]   async (ctx, record, t) => void (throw to block)
 * @param {Function} [cfg.serialize]      (record) => plain object
 */
export function createCrudService(cfg) {
  const {
    model,
    label,
    listOptions,
    uniqueFields = [],
    include,
    scopeWhere,
    beforeSave,
    afterSave,
    beforeDelete,
  } = cfg;
  const serialize = cfg.serialize ?? ((r) => r.toJSON());
  const baseWhere = (ctx) => ({ companyId: ctx.auth.companyId });
  // Tenant + visibility scope; applied to every read and write so ids can't reach outside it.
  const scoped = (ctx, ...extra) => ({ [Op.and]: [baseWhere(ctx), scopeWhere?.(ctx) ?? {}, ...extra] });

  async function find(ctx, id, options = {}) {
    const row = await model.findOne({ where: scoped(ctx, { id }), include: include?.(), ...options });
    if (!row) throw AppError.notFound(`${label} not found`);
    return row;
  }

  async function assertUnique(ctx, data, exceptId, transaction) {
    const conflicts = [];
    for (const field of uniqueFields) {
      if (data[field] === undefined) continue;
      // uniqueScope narrows uniqueness further (e.g. party group codes are unique per type).
      const where = { ...baseWhere(ctx), ...(cfg.uniqueScope?.(ctx) ?? {}), [field]: data[field] };
      if (exceptId) where.id = { [Op.ne]: exceptId };
      if (await model.count({ where, transaction })) {
        conflicts.push({ field, message: `This ${field} is already in use` });
      }
    }
    if (conflicts.length) throw AppError.conflict(`${label} already exists`, conflicts);
  }

  return {
    find,
    serialize,

    async list(ctx, query) {
      const q = parseListQuery(query, listOptions);
      const { rows, count } = await model.findAndCountAll({
        where: scoped(ctx, q.where),
        include: include?.(),
        order: q.order,
        limit: q.limit,
        offset: q.offset,
        distinct: true,
      });
      return { rows: rows.map(serialize), count, page: q.page, limit: q.limit };
    },

    async get(ctx, id) {
      return serialize(await find(ctx, id));
    },

    async create(ctx, input) {
      const record = await sequelize.transaction(async (t) => {
        const data = (await beforeSave?.(ctx, { ...input }, null, t)) ?? input;
        await assertUnique(ctx, data, null, t);
        const created = await model.create(
          { ...data, companyId: ctx.auth.companyId, createdBy: ctx.auth.userId, updatedBy: ctx.auth.userId },
          { transaction: t },
        );
        await afterSave?.(ctx, created, data, t);
        return created;
      });
      return serialize(await find(ctx, record.id));
    },

    async update(ctx, id, input) {
      await sequelize.transaction(async (t) => {
        const existing = await find(ctx, id, { transaction: t, lock: t.LOCK.UPDATE });
        const data = (await beforeSave?.(ctx, { ...input }, existing, t)) ?? input;
        await assertUnique(ctx, data, existing.id, t);
        await existing.update({ ...data, updatedBy: ctx.auth.userId }, { transaction: t });
        await afterSave?.(ctx, existing, data, t);
      });
      return serialize(await find(ctx, id));
    },

    async remove(ctx, id) {
      await sequelize.transaction(async (t) => {
        const existing = await find(ctx, id, { transaction: t, lock: t.LOCK.UPDATE });
        await beforeDelete?.(ctx, existing, t);
        // Soft-deleted rows keep their unique values; retire them so they can be reused.
        const retired = Object.fromEntries(
          uniqueFields
            .filter((f) => existing[f] != null)
            .map((f) => [
              f,
              retiredValue(existing[f], existing.id, model.rawAttributes[f].type.options?.length ?? 191),
            ]),
        );
        await existing.update({ ...retired, updatedBy: ctx.auth.userId }, { transaction: t });
        await existing.destroy({ transaction: t });
      });
    },
  };
}

/** Request context passed to services: who is acting and which branches they may touch. */
export const ctxOf = (req) => ({
  auth: req.auth,
  branchId: req.branchId ?? null,
  branchIds: req.branchIds ?? [],
});

/**
 * Express router for a CRUD service with permission checks and generated Swagger docs.
 * `extend(router, { can, scope })` adds custom routes after authentication and before the
 * generic /:id routes (so e.g. GET /tree is not swallowed by GET /:id).
 */
export function createCrudRouter({
  service,
  basePath,
  tag,
  label,
  permission,
  createSchema,
  updateSchema,
  listQuerySchema,
  branchScoped = false,
  extend,
}) {
  const router = Router();
  const scope = branchScoped ? [branchScope] : [];
  const can = (action) => authorize(`${permission}.${action}`);

  router.use(authenticate);
  extend?.(router, { can, scope });
  router.get('/', can('view'), ...scope, validate({ query: listQuerySchema }), async (req, res) => {
    const { rows, count, page, limit } = await service.list(ctxOf(req), req.validated.query ?? req.query);
    return sendPaginated(res, { rows, count }, { page, limit });
  });
  router.get('/:id', can('view'), ...scope, validate({ params: idParams }), async (req, res) =>
    sendSuccess(res, { data: await service.get(ctxOf(req), req.validated.params.id) }),
  );
  router.post('/', can('create'), ...scope, validate({ body: createSchema }), async (req, res) =>
    sendCreated(res, await service.create(ctxOf(req), req.validated.body), `${label} created`),
  );
  router.patch(
    '/:id',
    can('update'),
    ...scope,
    validate({ params: idParams, body: updateSchema }),
    async (req, res) =>
      sendSuccess(res, {
        data: await service.update(ctxOf(req), req.validated.params.id, req.validated.body),
        message: `${label} updated`,
      }),
  );
  router.delete('/:id', can('delete'), ...scope, validate({ params: idParams }), async (req, res) => {
    await service.remove(ctxOf(req), req.validated.params.id);
    return sendSuccess(res, { message: `${label} deleted` });
  });

  documentRoutes(basePath, tag, [
    {
      method: 'get',
      path: '',
      summary: `List ${label.toLowerCase()}s`,
      permission: `${permission}.view`,
      list: true,
    },
    {
      method: 'post',
      path: '',
      summary: `Create a ${label.toLowerCase()}`,
      permission: `${permission}.create`,
      body: createSchema,
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
      summary: `Update a ${label.toLowerCase()}`,
      permission: `${permission}.update`,
      body: updateSchema,
    },
    {
      method: 'delete',
      path: '/:id',
      summary: `Delete a ${label.toLowerCase()}`,
      permission: `${permission}.delete`,
    },
  ]);

  return router;
}
