import path from 'node:path';
import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env.js';

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: `${env.APP_NAME} API`,
      version: '1.0.0',
      description: 'Holydeen ERP REST API (v1)',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string' },
            errors: { type: 'array', items: { type: 'object' } },
          },
        },
        PaginationMeta: {
          type: 'object',
          properties: {
            page: { type: 'integer', example: 1 },
            limit: { type: 'integer', example: 20 },
            total: { type: 'integer', example: 120 },
            totalPages: { type: 'integer', example: 6 },
          },
        },
      },
    },
  },
  apis: [path.join(env.ROOT_DIR, 'src/modules/**/*.routes.js').replace(/\\/g, '/')],
});

/** Merge programmatically generated paths (see utils/docs.js) into the spec. */
export function registerPaths(paths) {
  for (const [p, ops] of Object.entries(paths)) {
    swaggerSpec.paths[p] = { ...swaggerSpec.paths[p], ...ops };
  }
}
