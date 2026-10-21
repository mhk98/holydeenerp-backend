import { sequelize } from '../../config/db.js';
import { PaymentMethod, Role, TaxGroup } from '../../models.js';
import { loadGroupRates } from '../taxes/taxes.service.js';
import { createOrderDraft, getOrder, withProductDefaults } from './orders.service.js';
import { D, fixed, invalid, priceLines, purchaseSettings } from './purchase.common.js';
import { remainingLines } from './requisitions.service.js';
import { createRfqDraft, getRfq } from './rfqs.service.js';

/** "Convert to" actions that start a document from a requisition, so nothing is typed twice. */

/** Approved requisition → draft purchase order for one supplier (the lines still to order). */
export async function requisitionToOrder(ctx, requisitionId, { supplierId, warehouseId }) {
  const order = await sequelize.transaction(async (t) => {
    const { doc, lines } = await remainingLines(ctx, requisitionId, t);
    const warehouse = warehouseId ?? doc.warehouseId;
    if (!warehouse) throw invalid('warehouseId', 'Choose the warehouse to deliver to');
    const items = await withProductDefaults(ctx, lines, t);
    return createOrderDraft(
      ctx,
      { supplierId, warehouseId: warehouse, items, notes: `From ${doc.number}` },
      t,
      { requisitionId: doc.id },
    );
  });
  return getOrder(ctx, order.id);
}

/** Approved requisition → draft RFQ to several suppliers. */
export async function requisitionToRfq(ctx, requisitionId, { supplierIds, quoteDeadline }) {
  const rfq = await sequelize.transaction(async (t) => {
    const { doc, lines } = await remainingLines(ctx, requisitionId, t);
    return createRfqDraft(ctx, { supplierIds, quoteDeadline, items: lines, notes: `From ${doc.number}` }, t, {
      requisitionId: doc.id,
      branchId: doc.branchId,
    });
  });
  return getRfq(ctx, rfq.id);
}

/** Lists the purchase forms need without settings access: tax groups, payment methods, roles, rules. */
export async function purchaseLookups(ctx) {
  const companyId = ctx.auth.companyId;
  const [groups, methods, roles, settings] = await Promise.all([
    TaxGroup.findAll({
      where: { companyId, isActive: true },
      attributes: ['id', 'name', 'code'],
      order: [['name', 'ASC']],
    }),
    PaymentMethod.findAll({
      where: { companyId, isActive: true },
      attributes: ['id', 'name', 'code', 'type', 'requiresReference'],
      order: [
        ['sortOrder', 'ASC'],
        ['name', 'ASC'],
      ],
    }),
    Role.findAll({ attributes: ['id', 'name', 'slug'], order: [['name', 'ASC']] }),
    purchaseSettings(companyId),
  ]);
  const taxGroups = [];
  for (const g of groups) {
    const rates = await loadGroupRates(companyId, g.id);
    const effective = priceLinesRate(rates);
    taxGroups.push({ id: String(g.id), name: g.name, code: g.code, rate: effective });
  }
  return {
    taxGroups,
    paymentMethods: methods.map((m) => m.toJSON()),
    roles: roles.map((r) => ({ id: String(r.id), name: r.name, slug: r.slug })),
    settings: {
      approvalLevels: settings.approvalLevels,
      requisitionApproval: settings.requisitionApproval,
      overReceiptPercent: settings.overReceiptPercent,
      defaultPaymentTermsDays: settings.defaultPaymentTermsDays,
    },
  };
}

/** Effective combined rate (%) of a tax group, for display. */
function priceLinesRate(rates) {
  let running = D(100);
  let total = D(0);
  for (const r of [...rates].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))) {
    const tax = (r.isCompound ? running : D(100)).times(r.rate).dividedBy(100);
    running = running.plus(tax);
    total = total.plus(tax);
  }
  return fixed(total, 2);
}

/** Totals preview for a form while it is being edited (all arithmetic stays on the server). */
export async function calculateTotals(ctx, items) {
  const { lines, totals } = await priceLines(ctx.auth.companyId, items, null);
  return {
    lines: lines.map((l) => ({
      lineSubtotal: l.lineSubtotal,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
    totals,
  };
}
