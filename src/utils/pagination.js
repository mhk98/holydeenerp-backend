import { Op } from 'sequelize';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Turn list query params into Sequelize findAndCountAll options.
 *
 * Supported params:
 *   page, limit                 — pagination (limit capped at 100)
 *   sort=field | sort=-field    — single or comma-separated; "-" means DESC
 *   search=text                 — LIKE across `searchable` fields
 *   any key in `filterable`     — exact match; comma-separated value → IN (...)
 *
 * Only whitelisted fields are ever used, so user input never reaches SQL identifiers.
 *
 * @param {object} query  req.query
 * @param {object} opts
 * @param {string[]} [opts.sortable]
 * @param {string[]} [opts.searchable]
 * @param {string[]} [opts.filterable]
 * @param {string}   [opts.defaultSort='-createdAt']
 */
export function parseListQuery(query = {}, opts = {}) {
  const { sortable = [], searchable = [], filterable = [], defaultSort = '-createdAt' } = opts;

  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_LIMIT));

  const toOrder = (sort) =>
    String(sort)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('-') ? [s.slice(1), 'DESC'] : [s, 'ASC']));

  const allowedSort = new Set([...sortable, defaultSort.replace(/^-/, '')]);
  const requested = toOrder(query.sort || '').filter(([field]) => allowedSort.has(field));
  const order = requested.length ? requested : toOrder(defaultSort);

  const where = {};
  for (const field of filterable) {
    const value = query[field];
    if (value === undefined || value === '') continue;
    // "true"/"false" from the query string must become real booleans for TINYINT columns.
    const values = String(value)
      .split(',')
      .map((v) => (v === 'true' ? true : v === 'false' ? false : v));
    where[field] = values.length > 1 ? { [Op.in]: values } : values[0];
  }

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search && searchable.length) {
    const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
    where[Op.or] = searchable.map((field) => ({ [field]: { [Op.like]: `%${escaped}%` } }));
  }

  return {
    page,
    limit,
    offset: (page - 1) * limit,
    order,
    where,
    search,
  };
}
