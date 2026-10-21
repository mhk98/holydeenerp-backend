import { BaseError, UniqueConstraintError, ValidationError, ForeignKeyConstraintError } from 'sequelize';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return AppError.unprocessable(
      'Validation failed',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }

  if (err instanceof UniqueConstraintError) {
    return AppError.conflict(
      'Duplicate value',
      err.errors.map((e) => ({ field: e.path, message: `${e.path} already exists` })),
    );
  }

  if (err instanceof ValidationError) {
    return AppError.unprocessable(
      'Validation failed',
      err.errors.map((e) => ({ field: e.path, message: e.message })),
    );
  }

  if (err instanceof ForeignKeyConstraintError) {
    return AppError.conflict('Operation violates a reference to another record');
  }

  if (err?.type === 'entity.parse.failed') return AppError.badRequest('Malformed JSON body');
  if (err?.type === 'entity.too.large') return new AppError('Request body too large', 413);

  if (err?.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? new AppError(`File is too large (max ${env.MAX_UPLOAD_MB} MB)`, 413)
      : AppError.badRequest(`Upload failed: ${err.message}`);
  }

  if (err instanceof BaseError) return new AppError('Database error', 500);

  return new AppError('Internal server error', err?.statusCode || err?.status || 500);
}

// Express identifies error handlers by their 4-argument signature.
export function errorHandler(err, req, res, next) {
  const appError = normalize(err);
  const { statusCode } = appError;

  if (statusCode >= 500) {
    logger.error(err.message, { stack: err.stack, method: req.method, url: req.originalUrl });
  } else {
    logger.warn(`${statusCode} ${req.method} ${req.originalUrl} — ${appError.message}`);
  }

  const body = { success: false, message: appError.message };
  if (appError.errors) body.errors = appError.errors;
  if (!env.isProd && statusCode >= 500) body.stack = err.stack;

  res.status(statusCode).json(body);
}

export function notFound(req, res, next) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}
