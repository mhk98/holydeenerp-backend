import { z } from 'zod';
import { name, optionalText } from './settings.schemas.js';
import { PAPER_SIZES, PRINT_DOC_TYPES } from './setting.model.js';
import { templateOptionsSchema } from './print-templates.service.js';

export const createTemplateSchema = z.object({
  name: name(100),
  docType: z.enum(PRINT_DOC_TYPES),
  paper: z.enum(PAPER_SIZES),
  isDefault: z.boolean().optional(),
  options: templateOptionsSchema.optional(),
  terms: optionalText(5000),
  footerNote: optionalText(500),
});
export const updateTemplateSchema = createTemplateSchema.partial();
export const listTemplateQuery = z
  .object({ docType: z.enum(PRINT_DOC_TYPES).optional(), paper: z.enum(PAPER_SIZES).optional() })
  .passthrough();
