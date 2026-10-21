import { Op } from 'sequelize';
import { z } from 'zod';
import { PrintTemplate } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';

/** Layout options a template can toggle. Unknown keys are rejected. */
export const templateOptionsSchema = z
  .object({
    title: z.string().trim().max(60),
    showLogo: z.boolean(),
    showCompanyAddress: z.boolean(),
    showBin: z.boolean(),
    showVatRegNo: z.boolean(),
    /** "Mushak-6.3" reference line required on Bangladesh VAT invoices. */
    showMushakRef: z.boolean(),
    showCustomerDetails: z.boolean(),
    showTaxBreakdown: z.boolean(),
    showAmountInWords: z.boolean(),
    showSignature: z.boolean(),
    showBarcode: z.boolean(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #0f172a'),
    fontSize: z.enum(['sm', 'md', 'lg']),
    headerText: z.string().trim().max(200),
  })
  .partial()
  .strict();

export const DEFAULT_OPTIONS = {
  a4: {
    title: 'Tax Invoice',
    showLogo: true,
    showCompanyAddress: true,
    showBin: true,
    showVatRegNo: false,
    showMushakRef: true,
    showCustomerDetails: true,
    showTaxBreakdown: true,
    showAmountInWords: true,
    showSignature: true,
    showBarcode: false,
    accentColor: '#0f172a',
    fontSize: 'md',
    headerText: '',
  },
  thermal_80: {
    title: 'Sales Receipt',
    showLogo: false,
    showCompanyAddress: true,
    showBin: true,
    showVatRegNo: false,
    showMushakRef: false,
    showCustomerDetails: false,
    showTaxBreakdown: true,
    showAmountInWords: false,
    showSignature: false,
    showBarcode: true,
    accentColor: '#000000',
    fontSize: 'sm',
    headerText: '',
  },
};

const serialize = (t) => {
  const json = t.toJSON();
  return { ...json, options: { ...DEFAULT_OPTIONS[t.paper], ...t.options } };
};

/** One default template per (document type, paper). */
export const printTemplateCrud = createCrudService({
  model: PrintTemplate,
  label: 'Print template',
  serialize,
  listOptions: {
    sortable: ['name', 'docType', 'createdAt'],
    searchable: ['name'],
    filterable: ['docType', 'paper'],
    defaultSort: 'docType',
  },
  beforeSave: async (ctx, data, existing) => {
    if (existing && data.paper && data.paper !== existing.paper) {
      throw AppError.badRequest('Create a new template to use a different paper size');
    }
    return data;
  },
  afterSave: async (ctx, template, data, t) => {
    const siblings = await PrintTemplate.count({
      where: { companyId: ctx.auth.companyId, docType: template.docType, paper: template.paper },
      transaction: t,
    });
    if (data.isDefault || siblings === 1) {
      await PrintTemplate.update(
        { isDefault: false },
        {
          where: {
            companyId: ctx.auth.companyId,
            docType: template.docType,
            paper: template.paper,
            id: { [Op.ne]: template.id },
          },
          transaction: t,
        },
      );
      await template.update({ isDefault: true }, { transaction: t });
    }
  },
});

/** Template used when printing a document (falls back to built-in defaults). */
export async function resolveTemplate(companyId, docType, paper) {
  const template = await PrintTemplate.findOne({ where: { companyId, docType, paper, isDefault: true } });
  if (template) return serialize(template);
  return {
    id: null,
    name: 'Default',
    docType,
    paper,
    options: DEFAULT_OPTIONS[paper],
    terms: null,
    footerNote: null,
  };
}
