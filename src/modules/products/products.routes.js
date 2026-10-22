import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { authorize } from '../../middlewares/rbac.js';
import { imageUpload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { createCrudRouter, ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams, idSchema } from '../../utils/validation.js';
import { attributeCrud } from '../attributes/attributes.service.js';
import * as attributeV from '../attributes/attributes.validation.js';
import { brandCrud, setBrandLogo } from '../brands/brands.service.js';
import * as brandV from '../brands/brands.validation.js';
import { categoryCrud, categoryTree, moveCategories } from '../categories/categories.service.js';
import * as categoryV from '../categories/categories.validation.js';
import { brandImport, categoryImport, productImport } from '../imports/definitions.js';
import { mountImportExport } from '../imports/import.routes.js';
import * as c from './products.controller.js';
import { MAX_IMAGES } from './products.service.js';
import * as v from './products.validation.js';

/** Product catalogue: products, categories, brands, attributes. Permission module: products.* */
export const productsRouter = Router();
productsRouter.use(authenticate);
const can = (action) => authorize(`products.${action}`);

// Static paths first so they are not taken for an :id.
productsRouter.get(
  '/barcode/generate',
  authorize('products.create', 'products.update'),
  validate({ query: v.barcodeQuery }),
  c.generateBarcode,
);
productsRouter.get('/labels', can('print'), validate({ query: v.labelsQuery }), c.labels);
productsRouter.get('/lookups', can('view'), c.lookups);
mountImportExport(productsRouter, productImport, {
  permission: 'products',
  basePath: '/products',
  tag: 'Products',
});

productsRouter.get('/', can('view'), validate({ query: v.listProductQuery }), c.list);
productsRouter.post('/', can('create'), validate({ body: v.productSchema }), c.create);
productsRouter.get('/:id', can('view'), validate({ params: idParams }), c.get);
productsRouter.put(
  '/:id',
  can('update'),
  validate({ params: idParams, body: v.updateProductSchema }),
  c.update,
);
productsRouter.delete('/:id', can('delete'), validate({ params: idParams }), c.remove);
productsRouter.post(
  '/:id/images',
  can('update'),
  validate({ params: idParams }),
  imageUpload({ maxFiles: MAX_IMAGES }).array('images', MAX_IMAGES),
  c.addImages,
);
productsRouter.put(
  '/:id/images/order',
  can('update'),
  validate({ params: idParams, body: v.imageOrderSchema }),
  c.orderImages,
);
productsRouter.delete(
  '/:id/images/:imageId',
  can('update'),
  validate({ params: z.object({ id: idSchema, imageId: idSchema }) }),
  c.deleteImage,
);

documentRoutes('/products', 'Products', [
  {
    method: 'get',
    path: '',
    summary:
      'List products (filters: type, categoryId incl. sub-categories, brandId, isActive; search also matches variant/pack barcodes)',
    permission: 'products.view',
    list: true,
  },
  {
    method: 'post',
    path: '',
    summary: 'Create a product with units and variants (blank SKU = generated)',
    permission: 'products.create',
    body: v.productSchema,
  },
  {
    method: 'get',
    path: '/:id',
    summary: 'Product with units, variants and images',
    permission: 'products.view',
  },
  {
    method: 'put',
    path: '/:id',
    summary: 'Replace a product (units and variants are synced)',
    permission: 'products.update',
    body: v.updateProductSchema,
  },
  { method: 'delete', path: '/:id', summary: 'Delete a product', permission: 'products.delete' },
  {
    method: 'get',
    path: '/barcode/generate',
    summary: 'Suggest a free barcode (EAN13 in-store or CODE128 from SKU)',
    permission: 'products.create',
  },
  {
    method: 'get',
    path: '/lookups',
    summary: 'Units and tax groups for the product form',
    permission: 'products.view',
  },
  {
    method: 'get',
    path: '/labels',
    summary: 'Label data for products (ids=1,2,3)',
    permission: 'products.print',
  },
  {
    method: 'post',
    path: '/:id/images',
    summary: `Upload images (multipart field "images", up to ${MAX_IMAGES})`,
    permission: 'products.update',
    multipart: true,
    noCreate: true,
  },
  {
    method: 'put',
    path: '/:id/images/order',
    summary: 'Reorder images (first = primary)',
    permission: 'products.update',
    body: v.imageOrderSchema,
  },
  {
    method: 'delete',
    path: '/:id/images/:imageId',
    summary: 'Delete an image',
    permission: 'products.update',
  },
]);

export const categoriesRouter = createCrudRouter({
  service: categoryCrud,
  basePath: '/product-categories',
  tag: 'Products · Categories',
  label: 'Category',
  permission: 'products',
  createSchema: categoryV.createCategorySchema,
  updateSchema: categoryV.updateCategorySchema,
  listQuerySchema: categoryV.listCategoryQuery,
  extend: (r, { can: allow }) => {
    r.get('/tree', allow('view'), async (req, res) =>
      sendSuccess(res, { data: await categoryTree(ctxOf(req)) }),
    );
    r.post('/move', allow('update'), validate({ body: categoryV.moveSchema }), async (req, res) =>
      sendSuccess(res, {
        data: await moveCategories(ctxOf(req), req.validated.body.items),
        message: 'Categories rearranged',
      }),
    );
    mountImportExport(r, categoryImport, {
      permission: 'products',
      basePath: '/product-categories',
      tag: 'Products · Categories',
    });
    documentRoutes('/product-categories', 'Products · Categories', [
      {
        method: 'get',
        path: '/tree',
        summary: 'Category tree with product counts',
        permission: 'products.view',
      },
      {
        method: 'post',
        path: '/move',
        summary: 'Re-parent / reorder categories (drag & drop)',
        permission: 'products.update',
        body: categoryV.moveSchema,
        noCreate: true,
      },
    ]);
  },
});

export const brandsRouter = createCrudRouter({
  service: brandCrud,
  basePath: '/brands',
  tag: 'Products · Brands',
  label: 'Brand',
  permission: 'products',
  createSchema: brandV.createBrandSchema,
  updateSchema: brandV.updateBrandSchema,
  listQuerySchema: brandV.listBrandQuery,
  extend: (r, { can: allow }) => {
    mountImportExport(r, brandImport, {
      permission: 'products',
      basePath: '/brands',
      tag: 'Products · Brands',
    });
    r.post(
      '/:id/logo',
      allow('update'),
      validate({ params: idParams }),
      imageUpload().single('logo'),
      async (req, res) =>
        sendSuccess(res, {
          data: await setBrandLogo(ctxOf(req), req.validated.params.id, req.file),
          message: 'Logo updated',
        }),
    );
    documentRoutes('/brands', 'Products · Brands', [
      {
        method: 'post',
        path: '/:id/logo',
        summary: 'Upload brand logo (multipart field "logo")',
        permission: 'products.update',
        multipart: true,
        noCreate: true,
      },
    ]);
  },
});

export const attributesRouter = createCrudRouter({
  service: attributeCrud,
  basePath: '/product-attributes',
  tag: 'Products · Attributes',
  label: 'Attribute',
  permission: 'products',
  createSchema: attributeV.createAttributeSchema,
  updateSchema: attributeV.updateAttributeSchema,
});
