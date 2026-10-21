import { sequelize } from '../../config/db.js';
import {
  Party,
  PurchaseRequisition,
  PurchaseRfq,
  PurchaseRfqItem,
  PurchaseRfqQuote,
  PurchaseRfqSupplier,
  TaxGroup,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertBranchAccess, companyToday, normalizeLines } from '../inventory/inventory.common.js';
import { nextNumber } from '../sequences/sequences.service.js';
import {
  D,
  branchRef,
  dateRange,
  findSupplier,
  fixed,
  inScope,
  invalid,
  lockDoc,
  priceLines,
  purchaseLineIncludes,
  userRef,
} from './purchase.common.js';
import { createOrderDraft } from './orders.service.js';

/**
 * Requests for quotation (optional step). Invite suppliers, record their quotes per line,
 * compare, then award one supplier — which creates a draft purchase order at the quoted prices.
 *   draft → sent → awarded, or cancelled.
 */

const LABEL = 'RFQ';

const LIST_OPTIONS = {
  sortable: ['number', 'rfqDate', 'quoteDeadline', 'createdAt'],
  searchable: ['number', 'notes'],
  filterable: ['status'],
  defaultSort: '-createdAt',
};

export async function listRfqs(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const { rows, count } = await PurchaseRfq.findAndCountAll({
    where: { ...q.where, companyId: ctx.auth.companyId, ...inScope(ctx), ...dateRange('rfqDate', query) },
    include: [
      userRef('creator'),
      { model: PurchaseRequisition, as: 'requisition', attributes: ['id', 'number'] },
    ],
    attributes: {
      include: [
        [
          sequelize.literal('(SELECT COUNT(*) FROM purchase_rfq_items i WHERE i.rfq_id = PurchaseRfq.id)'),
          'itemsCount',
        ],
        [
          sequelize.literal(
            '(SELECT COUNT(*) FROM purchase_rfq_suppliers s WHERE s.rfq_id = PurchaseRfq.id)',
          ),
          'suppliersCount',
        ],
        [
          sequelize.literal(
            "(SELECT COUNT(*) FROM purchase_rfq_suppliers s WHERE s.rfq_id = PurchaseRfq.id AND s.status IN ('quoted', 'awarded'))",
          ),
          'quotedCount',
        ],
      ],
    },
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

/** RFQ with its lines, suppliers and a comparison (best quoted price per line). */
export async function getRfq(ctx, id) {
  const doc = await PurchaseRfq.findOne({
    where: { id, companyId: ctx.auth.companyId, ...inScope(ctx) },
    include: [
      branchRef(),
      userRef('creator'),
      userRef('awarder'),
      { model: PurchaseRequisition, as: 'requisition', attributes: ['id', 'number'] },
      {
        model: PurchaseRfqItem,
        as: 'items',
        include: purchaseLineIncludes({ tax: false }),
        separate: true,
        order: [['sortOrder', 'ASC']],
      },
      {
        model: PurchaseRfqSupplier,
        as: 'suppliers',
        separate: true,
        include: [
          {
            model: Party,
            as: 'supplier',
            attributes: ['id', 'code', 'name', 'email', 'phone'],
            paranoid: false,
          },
          {
            model: PurchaseRfqQuote,
            as: 'quotes',
            include: [{ model: TaxGroup, as: 'taxGroup', attributes: ['id', 'name'] }],
          },
        ],
        order: [['id', 'ASC']],
      },
    ],
  });
  if (!doc) throw AppError.notFound(`${LABEL} not found`);
  const json = doc.toJSON();
  // Best net price per line among suppliers that quoted.
  const best = {};
  for (const s of json.suppliers) {
    for (const q of s.quotes) {
      const net = D(q.unitPrice).times(D(100).minus(q.discountPercent)).dividedBy(100);
      if (!best[q.rfqItemId] || net.lt(best[q.rfqItemId].net))
        best[q.rfqItemId] = { net, rfqSupplierId: String(s.id) };
    }
  }
  return {
    ...json,
    bestQuotes: Object.fromEntries(
      Object.entries(best).map(([k, v]) => [k, { unitPrice: fixed(v.net), rfqSupplierId: v.rfqSupplierId }]),
    ),
  };
}

async function writeDraft(ctx, doc, input, t) {
  const lines = await normalizeLines(ctx, input.items, t);
  const supplierIds = [...new Set(input.supplierIds.map(String))];
  for (const [i, sid] of supplierIds.entries()) await findSupplier(ctx, sid, t, `supplierIds.${i}`);
  await doc.update(
    {
      rfqDate: input.rfqDate ?? doc.rfqDate,
      quoteDeadline: input.quoteDeadline ?? null,
      notes: input.notes ?? null,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await PurchaseRfqItem.destroy({ where: { rfqId: doc.id }, transaction: t });
  await PurchaseRfqItem.bulkCreate(
    lines.map((l, i) => ({
      rfqId: doc.id,
      requisitionItemId: l.requisitionItemId ?? null,
      productId: l.productId,
      variantId: l.variantId,
      unitId: l.unitId,
      unitFactor: l.unitFactor,
      quantity: fixed(l.quantity),
      baseQuantity: l.baseQuantity,
      notes: l.notes ?? null,
      sortOrder: i,
    })),
    { transaction: t },
  );
  await PurchaseRfqSupplier.destroy({ where: { rfqId: doc.id }, transaction: t });
  await PurchaseRfqSupplier.bulkCreate(
    supplierIds.map((supplierId) => ({ rfqId: doc.id, supplierId })),
    { transaction: t },
  );
}

export async function createRfqDraft(ctx, input, t, { requisitionId = null, branchId = null } = {}) {
  const branch =
    branchId ?? ctx.branchId ?? ctx.auth.branches?.find((b) => b.isDefault)?.id ?? ctx.auth.branchIds?.[0];
  if (!branch) throw AppError.forbidden('You have no branch to raise an RFQ for');
  assertBranchAccess(ctx, branch);
  const number = await nextNumber({
    companyId: ctx.auth.companyId,
    docType: 'purchase_rfq',
    branchId: branch,
    transaction: t,
  });
  const doc = await PurchaseRfq.create(
    {
      companyId: ctx.auth.companyId,
      branchId: branch,
      requisitionId,
      number,
      rfqDate: input.rfqDate ?? (await companyToday(ctx.auth.companyId)),
      status: 'draft',
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    },
    { transaction: t },
  );
  await writeDraft(ctx, doc, input, t);
  return doc;
}

export async function createRfq(ctx, input) {
  const doc = await sequelize.transaction((t) => createRfqDraft(ctx, input, t));
  return getRfq(ctx, doc.id);
}

export async function updateRfq(ctx, id, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await writeDraft(ctx, doc, input, t);
  });
  return getRfq(ctx, id);
}

export async function deleteRfq(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['draft', 'cancelled'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ number: retiredValue(doc.number, doc.id, 60) }, { transaction: t });
    await doc.destroy({ transaction: t });
  });
}

/** Mark as sent to the suppliers (quotes can be recorded from now on). */
export async function sendRfq(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['draft'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ status: 'sent', sentAt: new Date(), updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return getRfq(ctx, id);
}

/** Record (or replace) one supplier's quote. */
export async function saveQuote(ctx, id, rfqSupplierId, input) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['sent'] });
    assertBranchAccess(ctx, doc.branchId);
    const rs = await PurchaseRfqSupplier.findOne({
      where: { id: rfqSupplierId, rfqId: doc.id },
      transaction: t,
    });
    if (!rs) throw AppError.notFound('This supplier is not on the RFQ');
    const items = await PurchaseRfqItem.findAll({ where: { rfqId: doc.id }, transaction: t });
    const itemOf = new Map(items.map((i) => [String(i.id), i]));
    if (input.status === 'quoted' && !input.quotes.length)
      throw invalid('quotes', 'Enter at least one price');
    for (const [i, q] of input.quotes.entries()) {
      if (!itemOf.has(String(q.rfqItemId)))
        throw invalid(`quotes.${i}.rfqItemId`, 'Line not found on this RFQ');
    }
    const priced =
      input.status === 'quoted'
        ? await priceLines(
            ctx.auth.companyId,
            input.quotes.map((q) => ({ ...q, quantity: itemOf.get(String(q.rfqItemId)).quantity })),
            t,
          )
        : { lines: [], totals: { total: '0' } };
    await PurchaseRfqQuote.destroy({ where: { rfqSupplierId: rs.id }, transaction: t });
    await PurchaseRfqQuote.bulkCreate(
      priced.lines.map((q) => ({
        rfqSupplierId: rs.id,
        rfqItemId: q.rfqItemId,
        unitPrice: fixed(q.unitPrice),
        discountPercent: q.discountPercent,
        taxGroupId: q.taxGroupId ?? null,
        notes: q.notes ?? null,
      })),
      { transaction: t },
    );
    await rs.update(
      {
        status: input.status,
        quoteDate: input.quoteDate ?? (await companyToday(ctx.auth.companyId)),
        validUntil: input.validUntil ?? null,
        deliveryDays: input.deliveryDays ?? null,
        notes: input.notes ?? null,
        total: priced.totals.total,
      },
      { transaction: t },
    );
  });
  return getRfq(ctx, id);
}

/** Award one supplier: creates a draft purchase order with the quoted lines. */
export async function awardRfq(ctx, id, { rfqSupplierId, warehouseId }) {
  return sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['sent'] });
    assertBranchAccess(ctx, doc.branchId);
    const rs = await PurchaseRfqSupplier.findOne({
      where: { id: rfqSupplierId, rfqId: doc.id },
      include: [{ model: PurchaseRfqQuote, as: 'quotes' }],
      transaction: t,
    });
    if (!rs) throw AppError.notFound('This supplier is not on the RFQ');
    if (rs.status !== 'quoted' || !rs.quotes.length)
      throw AppError.conflict('Record this supplier’s quote before awarding');

    const items = await PurchaseRfqItem.findAll({
      where: { rfqId: doc.id },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const quoteOf = new Map(rs.quotes.map((q) => [String(q.rfqItemId), q]));
    const lines = items
      .filter((i) => quoteOf.has(String(i.id)))
      .map((i) => {
        const q = quoteOf.get(String(i.id));
        return {
          productId: String(i.productId),
          variantId: i.variantId ? String(i.variantId) : null,
          unitId: i.unitId,
          quantity: i.quantity,
          unitPrice: q.unitPrice,
          discountPercent: q.discountPercent,
          taxGroupId: q.taxGroupId,
          requisitionItemId: i.requisitionItemId ? String(i.requisitionItemId) : null,
          notes: i.notes,
        };
      });
    const warehouse =
      warehouseId ??
      (doc.requisitionId
        ? (await PurchaseRequisition.findByPk(doc.requisitionId, { transaction: t }))?.warehouseId
        : null);
    if (!warehouse) throw invalid('warehouseId', 'Choose the warehouse to deliver to');
    const order = await createOrderDraft(
      ctx,
      { supplierId: rs.supplierId, warehouseId: warehouse, items: lines, notes: `From ${doc.number}` },
      t,
      { requisitionId: doc.requisitionId, rfqId: doc.id },
    );
    await rs.update({ status: 'awarded' }, { transaction: t });
    await doc.update(
      { status: 'awarded', awardedBy: ctx.auth.userId, awardedAt: new Date(), updatedBy: ctx.auth.userId },
      { transaction: t },
    );
    return { id: String(order.id), number: order.number };
  });
}

export async function cancelRfq(ctx, id) {
  await sequelize.transaction(async (t) => {
    const doc = await lockDoc(PurchaseRfq, ctx, id, t, { label: LABEL, allowed: ['draft', 'sent'] });
    assertBranchAccess(ctx, doc.branchId);
    await doc.update({ status: 'cancelled', updatedBy: ctx.auth.userId }, { transaction: t });
  });
  return getRfq(ctx, id);
}
