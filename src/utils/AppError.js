/**
 * Operational error with an HTTP status. Throw from services; the central
 * error handler turns it into the standard error response.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, errors = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Bad request', errors) {
    return new AppError(message, 400, errors);
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(message, 401);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(message, 403);
  }

  static notFound(message = 'Resource not found') {
    return new AppError(message, 404);
  }

  static conflict(message = 'Resource already exists', errors) {
    return new AppError(message, 409, errors);
  }

  static unprocessable(message = 'Validation failed', errors) {
    return new AppError(message, 422, errors);
  }

  static serviceUnavailable(message = 'Service temporarily unavailable') {
    return new AppError(message, 503);
  }
}
