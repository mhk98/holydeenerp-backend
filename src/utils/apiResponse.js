/**
 * Standard API envelope: { success, message, data, meta? }.
 */
export function sendSuccess(res, { data = null, message = 'OK', statusCode = 200, meta } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

export function sendCreated(res, data, message = 'Created successfully') {
  return sendSuccess(res, { data, message, statusCode: 201 });
}

/**
 * For list endpoints. `result` is the output of Model.findAndCountAll(),
 * `query` is the output of parseListQuery().
 */
export function sendPaginated(res, { rows, count }, { page, limit }, message = 'OK') {
  return sendSuccess(res, {
    data: rows,
    message,
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) || 0 },
  });
}
