import { z } from 'zod';
import { env } from '../config/env.js';
import { registerPaths } from '../config/swagger.js';

const jsonSchema = (schema) => {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
};

const listParams = [
  { in: 'query', name: 'page', schema: { type: 'integer' } },
  { in: 'query', name: 'limit', schema: { type: 'integer' } },
  { in: 'query', name: 'sort', schema: { type: 'string' }, description: '"field" or "-field"' },
  { in: 'query', name: 'search', schema: { type: 'string' } },
];

/**
 * Generate OpenAPI docs for routes from their Zod schemas, so docs never drift from validation.
 *
 * documentRoutes('/settings/units', 'Settings · Units', [
 *   { method: 'get', path: '', summary: 'List units', permission: 'settings.view', list: true },
 *   { method: 'post', path: '', summary: 'Create a unit', permission: 'settings.create', body: createSchema },
 * ]);
 */
export function documentRoutes(basePath, tag, routes) {
  // Skip the Zod → JSON Schema conversion entirely when the docs are not served.
  if (!env.API_DOCS_ENABLED) return;
  const paths = {};
  for (const r of routes) {
    const openApiPath = `${basePath}${r.path ?? ''}`.replace(/:(\w+)/g, '{$1}');
    const pathParams = [...openApiPath.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
      in: 'path',
      name,
      required: true,
      schema: { type: 'string' },
    }));
    paths[openApiPath] ??= {};
    paths[openApiPath][r.method] = {
      tags: [tag],
      summary: r.summary,
      description: [r.description, r.permission && `Requires \`${r.permission}\`.`]
        .filter(Boolean)
        .join('\n\n'),
      security: r.public ? [] : [{ bearerAuth: [] }],
      parameters: [...pathParams, ...(r.list ? listParams : []), ...(r.query ?? [])],
      ...(r.body && {
        requestBody: {
          required: true,
          content: {
            [r.multipart ? 'multipart/form-data' : 'application/json']: { schema: jsonSchema(r.body) },
          },
        },
      }),
      responses: {
        [r.method === 'post' && !r.noCreate ? 201 : 200]: { description: r.response ?? 'OK' },
        ...(!r.public && {
          401: { description: 'Not signed in' },
          403: { description: 'Missing permission' },
        }),
        ...(r.body && { 422: { description: 'Validation failed' } }),
      },
    };
  }
  registerPaths(paths);
}
