import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import * as products from './products.service.js';

export async function list(req, res) {
  const { rows, count, page, limit } = await products.listProducts(ctxOf(req), req.validated.query);
  return sendPaginated(res, { rows, count }, { page, limit });
}

export const get = async (req, res) =>
  sendSuccess(res, { data: await products.getProduct(ctxOf(req), req.validated.params.id) });

export const create = async (req, res) =>
  sendCreated(res, await products.saveProduct(ctxOf(req), null, req.validated.body), 'Product created');

export const update = async (req, res) =>
  sendSuccess(res, {
    data: await products.saveProduct(ctxOf(req), req.validated.params.id, req.validated.body),
    message: 'Product updated',
  });

export async function remove(req, res) {
  await products.deleteProduct(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Product deleted' });
}

export const generateBarcode = async (req, res) =>
  sendSuccess(res, { data: await products.generateBarcode(ctxOf(req), req.validated.query) });

export const labels = async (req, res) =>
  sendSuccess(res, { data: await products.labelData(ctxOf(req), req.validated.query.ids.split(',')) });

export const addImages = async (req, res) =>
  sendSuccess(res, {
    data: await products.addImages(ctxOf(req), req.validated.params.id, req.files),
    message: 'Images uploaded',
  });

export const deleteImage = async (req, res) =>
  sendSuccess(res, {
    data: await products.deleteImage(ctxOf(req), req.validated.params.id, req.validated.params.imageId),
    message: 'Image deleted',
  });

export const orderImages = async (req, res) =>
  sendSuccess(res, {
    data: await products.orderImages(ctxOf(req), req.validated.params.id, req.validated.body.imageIds),
  });

export const lookups = async (req, res) =>
  sendSuccess(res, { data: await products.productLookups(ctxOf(req)) });
