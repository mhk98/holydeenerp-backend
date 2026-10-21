import { z } from 'zod';
import { idSchema } from '../../utils/validation.js';
import { boolFilter, decimalString, name, optionalText } from '../settings/settings.schemas.js';
import { BARCODE_TYPES, PRODUCT_TYPES } from './product.model.js';

const sku = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Za-z0-9._\-/]*$/, 'Use letters, numbers and . _ - /');
const barcode = z
  .string()
  .trim()
  .max(64)
  .nullish()
  .transform((v) => v || null);
const amount = decimalString({ allowZero: true, scale: 4 });
const optionalAmount = amount.nullish().or(z.literal('').transform(() => null));

const unitRow = z.object({
  unitId: idSchema,
  factor: decimalString({ scale: 6 }),
  barcode,
  purchasePrice: optionalAmount,
  salePrice: optionalAmount,
  isDefaultPurchase: z.boolean().optional(),
  isDefaultSale: z.boolean().optional(),
});

const variantRow = z.object({
  id: idSchema.optional(),
  attributeValueIds: z.array(idSchema).min(1, 'Pick a value for each attribute'),
  sku: sku.optional(),
  barcode,
  purchasePrice: optionalAmount,
  salePrice: optionalAmount,
  isActive: z.boolean().optional(),
});

export const productSchema = z
  .object({
    /** Leave empty to generate from the "product_sku" number series. */
    sku: sku.optional(),
    name: name(200),
    type: z.enum(PRODUCT_TYPES),
    barcode,
    barcodeType: z.enum(BARCODE_TYPES).optional(),
    categoryId: idSchema.nullish(),
    brandId: idSchema.nullish(),
    baseUnitId: idSchema,
    purchasePrice: amount.optional(),
    salePrice: amount.optional(),
    taxGroupId: idSchema.nullish(),
    priceIncludesTax: z.boolean().optional(),
    reorderLevel: amount.optional(),
    trackBatch: z.boolean().optional(),
    trackSerial: z.boolean().optional(),
    trackExpiry: z.boolean().optional(),
    hasVariants: z.boolean().optional(),
    description: optionalText(5000),
    isActive: z.boolean().optional(),
    units: z.array(unitRow).optional(),
    variants: z.array(variantRow).optional(),
  })
  .refine((p) => !(p.type === 'service' && (p.trackBatch || p.trackSerial || p.trackExpiry)), {
    message: 'Services are not stocked, so they cannot track batches, serials or expiry',
    path: ['type'],
  });

/** The product form always sends the whole product, so updates use the same schema. */
export const updateProductSchema = productSchema;

export const listProductQuery = z
  .object({
    type: z.enum(PRODUCT_TYPES).optional(),
    categoryId: idSchema.optional(),
    brandId: idSchema.optional(),
    isActive: boolFilter,
    hasVariants: boolFilter,
  })
  .passthrough();

export const barcodeQuery = z.object({
  type: z.enum(BARCODE_TYPES).default('EAN13'),
  sku: z.string().trim().max(60).optional(),
});

export const imageOrderSchema = z.object({ imageIds: z.array(idSchema).min(1) });

export const labelsQuery = z.object({ ids: z.string().regex(/^\d+(,\d+)*$/, 'Comma-separated product ids') });
