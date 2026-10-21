/**
 * Validate request parts against Zod schemas.
 * Usage: router.post('/', validate({ body: createSchema }), controller.create)
 *
 * Parsed (coerced/defaulted) values are exposed on req.validated.{body,query,params}.
 * ZodErrors propagate to the central error handler, which formats them as 422.
 */
export const validate = (schemas) => (req, res, next) => {
  req.validated = {};
  for (const part of ['params', 'query', 'body']) {
    if (schemas[part]) req.validated[part] = schemas[part].parse(req[part] ?? {});
  }
  next();
};
