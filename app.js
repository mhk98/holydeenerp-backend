import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';

import { env } from './src/config/env.js';
import { morganStream } from './src/config/logger.js';
import { swaggerSpec } from './src/config/swagger.js';
import { apiLimiter } from './src/middlewares/rateLimit.js';
import { requireDatabase } from './src/middlewares/databaseReady.js';
import { sanitizeInput } from './src/middlewares/sanitize.js';
import { errorHandler, notFound } from './src/middlewares/errorHandler.js';
import apiRoutes from './src/routes.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Swagger UI needs inline scripts/styles, so it is mounted before the strict global CSP.
// Off in production unless API_DOCS_ENABLED=true (swaggerSpec is null then).
if (swaggerSpec) {
  app.use(
    '/api/docs',
    helmet({ contentSecurityPolicy: false }),
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, { customSiteTitle: `${env.APP_NAME} API` }),
  );
  app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
}

app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / server-to-server requests (no Origin header) and whitelisted origins.
      if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    // The deployed web app is on another origin and sends Authorization, so every API call needs a
    // preflight; let browsers reuse it for 2 h (Chrome's cap) instead of doubling each request.
    maxAge: 7200,
  }),
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(sanitizeInput);

if (!env.isTest) {
  app.use(morgan(env.isProd ? 'combined' : 'dev', { stream: morganStream }));
}

// Uploaded files (avatars, logos). Images may be embedded by the web app on another origin.
app.use(
  '/uploads',
  helmet.crossOriginResourcePolicy({ policy: 'cross-origin' }),
  express.static(path.resolve(env.ROOT_DIR, env.UPLOAD_DIR), {
    maxAge: '7d',
    index: false,
    dotfiles: 'deny',
  }),
);

app.use('/api', apiLimiter);
app.use('/api/v1', requireDatabase, apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
