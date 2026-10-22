import { Brand, Product } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { removeImage, saveImage } from '../../utils/storage.js';

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

export async function setBrandLogo(ctx, id, file) {
  if (!file) throw AppError.badRequest('Please choose an image to upload');
  const brand = await brandCrud.find(ctx, id);
  const previous = brand.logoUrl;
  await brand.update({ logoUrl: await saveImage(file, 'brands'), updatedBy: ctx.auth.userId });
  await removeImage(previous);
  return brandCrud.get(ctx, id);
}
