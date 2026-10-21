import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { Brand, Product } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

export const brandCrud = createCrudService({
  model: Brand,
  label: 'Brand',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'code', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['isActive'],
    defaultSort: 'name',
  },
  beforeSave: async (ctx, data) => {
    if (data.code) data.code = data.code.toUpperCase();
    return data;
  },
  beforeDelete: async (ctx, brand, t) => {
    const products = await Product.count({ where: { brandId: brand.id }, transaction: t });
    if (products) throw AppError.conflict(`${products} product(s) use this brand. Change them first.`);
  },
});

async function removeUpload(publicUrl) {
  if (!publicUrl?.startsWith('/uploads/')) return;
  const root = path.resolve(env.ROOT_DIR, env.UPLOAD_DIR);
  const file = path.resolve(root, publicUrl.slice('/uploads/'.length));
  if (file.startsWith(root)) await fs.unlink(file).catch(() => {});
}

export async function setBrandLogo(ctx, id, file) {
  if (!file) throw AppError.badRequest('Please choose an image to upload');
  const brand = await brandCrud.find(ctx, id);
  const previous = brand.logoUrl;
  await brand.update({ logoUrl: `/uploads/brands/${file.filename}`, updatedBy: ctx.auth.userId });
  await removeUpload(previous);
  return brandCrud.get(ctx, id);
}

export { removeUpload };
