import { TaxGroup, TaxGroupRate, TaxRate } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { assertUnused } from '../../utils/usage.js';
import { getSettings } from '../settings/settings.service.js';
import { calculateTax } from './tax.calculator.js';

export const taxRateCrud = createCrudService({
  model: TaxRate,
  label: 'Tax rate',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'code', 'rate', 'createdAt'],
    searchable: ['name', 'code'],
    filterable: ['type', 'isActive'],
    defaultSort: 'name',
  },
  beforeSave: async (ctx, data) => {
    if (data.code) data.code = data.code.toUpperCase();
    return data;
  },
  beforeDelete: async (ctx, rate, t) => {
    const used = await TaxGroupRate.count({ where: { taxRateId: rate.id }, transaction: t });
    if (used)
      throw AppError.conflict(`This rate is used in ${used} tax group(s). Remove it from them first.`);
  },
});

const groupInclude = () => [
  {
    model: TaxRate,
    as: 'rates',
    attributes: ['id', 'name', 'code', 'type', 'rate', 'isActive'],
    through: { attributes: ['sequence', 'isCompound'] },
  },
];

function serializeGroup(group) {
  const rates = [...(group.rates ?? [])]
    .sort((a, b) => a.TaxGroupRate.sequence - b.TaxGroupRate.sequence)
    .map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      type: r.type,
      rate: r.rate,
      isActive: r.isActive,
      sequence: r.TaxGroupRate.sequence,
      isCompound: r.TaxGroupRate.isCompound,
    }));
  const { effectiveRate } = calculateTax({ amount: 100, rates });
  return {
    id: group.id,
    name: group.name,
    code: group.code,
    description: group.description,
    isActive: group.isActive,
    rates,
    effectiveRate,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

async function writeGroupRates(ctx, groupId, rates, t) {
  if (rates.length) {
    const found = await TaxRate.count({
      where: { id: rates.map((r) => r.taxRateId), companyId: ctx.auth.companyId },
      transaction: t,
    });
    if (found !== rates.length) {
      throw AppError.unprocessable('Validation failed', [
        { field: 'rates', message: 'One or more tax rates are invalid' },
      ]);
    }
  }
  await TaxGroupRate.destroy({ where: { taxGroupId: groupId }, transaction: t });
  await TaxGroupRate.bulkCreate(
    rates.map((r, i) => ({
      taxGroupId: groupId,
      taxRateId: r.taxRateId,
      sequence: i + 1,
      isCompound: r.isCompound,
    })),
    { transaction: t },
  );
}

/** Document lines that carry a tax group. */
const TAXED_LINE_TABLES = [
  'sales_quotation_items',
  'sales_order_items',
  'sales_invoice_items',
  'sales_return_items',
  'purchase_rfq_quotes',
  'purchase_order_items',
  'goods_receipt_items',
  'supplier_bill_items',
  'purchase_return_items',
];

const groupBase = createCrudService({
  model: TaxGroup,
  label: 'Tax group',
  uniqueFields: ['code'],
  include: groupInclude,
  serialize: serializeGroup,
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
  afterSave: async (ctx, group, data, t) => {
    if (data.rates) await writeGroupRates(ctx, group.id, data.rates, t);
  },
  beforeDelete: (ctx, group, t) =>
    assertUnused(
      group.id,
      [
        { table: 'products', column: 'tax_group_id', label: 'product', paranoid: true },
        ...TAXED_LINE_TABLES.map((table) => ({ table, column: 'tax_group_id', label: 'document line' })),
      ],
      { what: `Tax group ${group.name}`, transaction: t },
    ),
});

export const taxGroupCrud = groupBase;

/** Preview the tax breakdown of a group for an amount (uses the company's amount precision). */
export async function calculateForGroup(ctx, groupId, { amount, inclusive }) {
  const group = await groupBase.get(ctx, groupId);
  const { amountDecimals } = await getSettings(ctx.auth.companyId, 'financial');
  return calculateTax({ amount, inclusive, decimals: amountDecimals, rates: group.rates });
}

/** For other modules: load a group's rates once and calculate inside a transaction. */
export async function loadGroupRates(companyId, groupId, transaction) {
  const group = await TaxGroup.findOne({
    where: { id: groupId, companyId },
    include: groupInclude(),
    transaction,
  });
  if (!group) throw AppError.badRequest('Tax group not found');
  return serializeGroup(group).rates;
}
