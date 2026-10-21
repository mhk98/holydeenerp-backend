import {
  BankAccount,
  Cheque,
  Company,
  CustomerReceipt,
  Expense,
  ExpenseCategory,
  Voucher,
  VoucherLine,
  GoodsReceiptItem,
  ManufacturingOrder,
  MoOperation,
  Party,
  PaymentMethod,
  PosSession,
  Product,
  PurchaseReturn,
  PurchaseReturnItem,
  SalesInvoice,
  SalesInvoiceItem,
  SalesReturn,
  SalesReturnItem,
  SupplierBill,
  SupplierBillItem,
  SupplierPayment,
} from '../../models.js';
import { roleOpening } from '../parties/party-balance.js';
import { MOVEMENT_CONTRA_KEY } from './chart.js';
import { chequeSourceVoided, registerCheque } from './cheques.service.js';
import {
  D,
  accountMap,
  ensureLedger,
  methodAccountId,
  postJournal,
  reverseSource,
} from './ledger.service.js';

/**
 * Central posting service: how each business event becomes a balanced journal. Modules call
 * postSource() / unpostSource() inside their own transaction; stock movements are valued by
 * postStockJournal(), called from the stock engine.
 *
 * Document journals (perpetual inventory — cost of goods is posted by the stock journals):
 *   sales invoice      Dr AR (total)        Cr Sales (net) · Cr VAT output · ± Rounding
 *   sales return       Dr Sales returns · Dr VAT output     Cr AR (total) · ± Rounding
 *   POS refund         Dr AR                Cr Cash / bank
 *   customer receipt   Dr Cash / bank       Cr AR
 *   supplier bill      Dr GRNI (goods) · Dr Purchased services · Dr VAT input     Cr AP · ± Rounding
 *   supplier payment   Dr AP                Cr Cash / bank
 *   purchase return    Dr AP                Cr VAT input · Cr GRNI (stock cost) · ± Price variance
 *   POS session close  ± Cash               ∓ Cash over / short
 *   party opening      ± AR / AP            ∓ Opening balance equity
 *   receipt voucher    Dr Cash / bank       Cr the lines          (payment voucher: the other way)
 *   contra voucher     Dr to-account        Cr from-account
 *   expense            Dr category account · Dr VAT input        Cr Cash / bank
 *   cheque cleared     Dr Bank              Cr Cheques in hand
 *   MO operation done  Dr WIP               Cr Labour & overhead applied   (event op:<id>)
 *   MO closed          Dr Production variance   Cr WIP (what the outputs did not absorb; ± )
 * (Materials into and products out of production are stock movements against WIP.)
 * A receipt / payment by cheque also registers the cheque; voiding it cancels an open cheque.
 */

const sum = (rows, field) => rows.reduce((s, r) => s.plus(r[field]), D(0));
const POSTED_INVOICE = ['unpaid', 'partially_paid', 'paid'];

/** Book whatever keeps the lines from balancing (sub-cent rounding) on `key`. */
function settle(lines, key, extra = {}) {
  const diff = lines.reduce((s, l) => s.plus(l.amount), D(0));
  if (!diff.isZero()) lines.push({ key, amount: diff.neg(), ...extra });
  return lines;
}

/** A date (Date) as YYYY-MM-DD in the company's timezone. */
async function localDate(companyId, date = new Date()) {
  const company = await Company.findByPk(companyId, { attributes: ['timezone'] });
  return new Intl.DateTimeFormat('en-CA', { timeZone: company?.timezone ?? 'Asia/Dhaka' }).format(date);
}

async function methodAccount(methodId, map, t, direction = 'in') {
  const method = await PaymentMethod.findByPk(methodId, { paranoid: false, transaction: t });
  return methodAccountId(method, map, direction);
}

/** Ledger account of a cash / bank account record. */
async function moneyAccount(bankAccountId, t) {
  const bank = await BankAccount.findByPk(bankAccountId, { paranoid: false, transaction: t });
  return String(bank.accountId);
}

/** Builders: (id, { t, map, companyId }) → { date, branchId, sourceNo, narration, lines } | null. */
const BUILDERS = {
  async 'sales_invoice.post'(id, { t }) {
    const inv = await SalesInvoice.findByPk(id, { transaction: t });
    if (!inv || !POSTED_INVOICE.includes(inv.status)) return null;
    const items = await SalesInvoiceItem.findAll({ where: { invoiceId: id }, transaction: t });
    const lines = [
      { key: 'ar', amount: D(inv.total), partyId: inv.customerId },
      { key: 'sales', amount: sum(items, 'lineSubtotal').neg() },
      { key: 'vatOutput', amount: sum(items, 'taxAmount').neg() },
    ];
    return {
      date: inv.invoiceDate,
      branchId: inv.branchId,
      sourceNo: inv.number,
      narration: `${inv.channel === 'pos' ? 'POS sale' : 'Sales invoice'} ${inv.number}`,
      lines: settle(lines, 'rounding'),
    };
  },

  async 'sales_return.post'(id, { t }) {
    const ret = await SalesReturn.findByPk(id, { transaction: t });
    if (!ret || ret.status !== 'posted') return null;
    const items = await SalesReturnItem.findAll({ where: { returnId: id }, transaction: t });
    const lines = [
      { key: 'salesReturns', amount: sum(items, 'lineSubtotal') },
      { key: 'vatOutput', amount: sum(items, 'taxAmount') },
      { key: 'ar', amount: D(ret.total).neg(), partyId: ret.customerId },
    ];
    return {
      date: ret.returnDate,
      branchId: ret.branchId,
      sourceNo: ret.number,
      narration: `${ret.type === 'credit_note' ? 'Credit note' : 'Sales return'} ${ret.number}`,
      lines: settle(lines, 'rounding'),
    };
  },

  async 'sales_return.refund'(id, { t, map }) {
    const ret = await SalesReturn.findByPk(id, { transaction: t });
    if (!ret || ret.status !== 'posted' || D(ret.refundedAmount).lte(0) || !ret.refundMethodId) return null;
    return {
      date: ret.returnDate,
      branchId: ret.branchId,
      sourceNo: ret.number,
      narration: `Refund on ${ret.number}`,
      lines: [
        { key: 'ar', amount: D(ret.refundedAmount), partyId: ret.customerId },
        {
          accountId: await methodAccount(ret.refundMethodId, map, t, 'out'),
          amount: D(ret.refundedAmount).neg(),
        },
      ],
    };
  },

  async 'customer_receipt.post'(id, { t, map }) {
    const rec = await CustomerReceipt.findByPk(id, { transaction: t });
    if (!rec || rec.status !== 'posted') return null;
    return {
      date: rec.receiptDate,
      branchId: rec.branchId,
      sourceNo: rec.number,
      reference: rec.reference,
      narration: `Money receipt ${rec.number}`,
      lines: [
        { accountId: await methodAccount(rec.paymentMethodId, map, t), amount: D(rec.amount) },
        { key: 'ar', amount: D(rec.amount).neg(), partyId: rec.customerId },
      ],
    };
  },

  async 'supplier_bill.post'(id, { t }) {
    const bill = await SupplierBill.findByPk(id, { transaction: t });
    if (!bill || !POSTED_INVOICE.includes(bill.status)) return null;
    const items = await SupplierBillItem.findAll({
      where: { billId: id },
      include: [{ model: Product, as: 'product', attributes: ['type'], paranoid: false }],
      transaction: t,
    });
    const lines = [
      ...items.map((i) => ({
        key: i.product?.type === 'service' ? 'purchaseExpense' : 'grni',
        amount: D(i.lineSubtotal),
      })),
      { key: 'vatInput', amount: sum(items, 'taxAmount') },
      { key: 'ap', amount: D(bill.total).neg(), partyId: bill.supplierId },
    ];
    return {
      date: bill.billDate,
      branchId: bill.branchId,
      sourceNo: bill.number,
      reference: bill.supplierInvoiceNo,
      narration: `Supplier bill ${bill.number}`,
      lines: settle(lines, 'rounding'),
    };
  },

  async 'supplier_payment.post'(id, { t, map }) {
    const pay = await SupplierPayment.findByPk(id, { transaction: t });
    if (!pay || pay.status !== 'posted') return null;
    return {
      date: pay.paymentDate,
      branchId: pay.branchId,
      sourceNo: pay.number,
      reference: pay.reference,
      narration: `Supplier payment ${pay.number}`,
      lines: [
        { key: 'ap', amount: D(pay.amount), partyId: pay.supplierId },
        { accountId: await methodAccount(pay.paymentMethodId, map, t, 'out'), amount: D(pay.amount).neg() },
      ],
    };
  },

  async 'purchase_return.post'(id, { t }) {
    const ret = await PurchaseReturn.findByPk(id, { transaction: t });
    if (!ret || ret.status !== 'posted') return null;
    const items = await PurchaseReturnItem.findAll({ where: { returnId: id }, transaction: t });
    const lines = [
      { key: 'ap', amount: D(ret.total), partyId: ret.supplierId },
      { key: 'vatInput', amount: sum(items, 'taxAmount').neg() },
    ];
    // Goods sent back leave stock at their stock cost (the stock journal debits GRNI with it).
    if (ret.type === 'return') lines.push({ key: 'grni', amount: sum(items, 'stockCost').neg() });
    return {
      date: ret.returnDate,
      branchId: ret.branchId,
      sourceNo: ret.number,
      narration: `${ret.type === 'debit_note' ? 'Debit note' : 'Purchase return'} ${ret.number}`,
      lines: settle(lines, 'purchaseVariance'),
    };
  },

  async 'pos_session.variance'(id, { t, map, companyId }) {
    const session = await PosSession.findByPk(id, { transaction: t });
    if (!session || session.status !== 'closed' || D(session.variance).isZero()) return null;
    const cash = await PaymentMethod.findOne({
      where: { companyId, type: 'cash', isActive: true },
      order: [['sortOrder', 'ASC']],
      transaction: t,
    });
    const cashAccount = cash ? methodAccountId(cash, map) : map.get('cash');
    return {
      date: await localDate(companyId, session.closedAt ?? new Date()),
      branchId: session.branchId,
      sourceNo: session.number,
      narration: `Cash ${D(session.variance).gt(0) ? 'over' : 'short'} on POS session ${session.number}`,
      lines: settle([{ accountId: cashAccount, amount: D(session.variance) }], 'cashOverShort'),
    };
  },

  async 'party.opening'(id, { t, companyId }) {
    const party = await Party.findByPk(id, { transaction: t });
    if (!party || D(party.openingBalance).isZero() || !(party.isCustomer || party.isSupplier)) return null;
    // Same split as the receivables / payables reports, so the control accounts agree with them.
    const lines = [];
    if (party.isCustomer)
      lines.push({ key: 'ar', amount: roleOpening(party, 'customer'), partyId: party.id });
    if (party.isSupplier)
      lines.push({ key: 'ap', amount: roleOpening(party, 'supplier').neg(), partyId: party.id });
    return {
      date: await localDate(companyId, party.createdAt ?? new Date()),
      sourceNo: party.code,
      narration: `Opening balance of ${party.name}`,
      lines: settle(lines, 'openingBalanceEquity'),
    };
  },

  async 'voucher.post'(id, { t }) {
    const v = await Voucher.findByPk(id, { transaction: t });
    if (!v || v.status !== 'posted') return null;
    const money = await moneyAccount(v.bankAccountId, t);
    let lines;
    if (v.voucherType === 'contra') {
      lines = [
        { accountId: await moneyAccount(v.toBankAccountId, t), amount: D(v.amount) },
        { accountId: money, amount: D(v.amount).neg() },
      ];
    } else {
      const sign = v.voucherType === 'receipt' ? 1 : -1;
      const items = await VoucherLine.findAll({
        where: { voucherId: id },
        order: [['sortOrder', 'ASC']],
        transaction: t,
      });
      lines = [
        { accountId: money, amount: D(v.amount).times(sign) },
        ...items.map((l) => ({
          accountId: l.accountId,
          amount: D(l.amount).times(-sign),
          description: l.description,
        })),
      ];
    }
    return {
      date: v.voucherDate,
      branchId: v.branchId,
      sourceNo: v.number,
      reference: v.reference,
      narration:
        v.narration ?? `${v.voucherType[0].toUpperCase()}${v.voucherType.slice(1)} voucher ${v.number}`,
      lines,
    };
  },

  async 'expense.post'(id, { t }) {
    const e = await Expense.findByPk(id, { transaction: t });
    if (!e || e.status !== 'posted') return null;
    const category = await ExpenseCategory.findByPk(e.categoryId, { paranoid: false, transaction: t });
    return {
      date: e.expenseDate,
      branchId: e.branchId,
      sourceNo: e.number,
      reference: e.reference,
      narration: e.description ?? `Expense ${e.number}${e.payee ? ` — ${e.payee}` : ''}`,
      lines: [
        { accountId: category.accountId, amount: D(e.amount) },
        { key: 'vatInput', amount: D(e.taxAmount) },
        { accountId: await moneyAccount(e.bankAccountId, t), amount: D(e.total).neg() },
      ],
    };
  },

  /** A received cheque cleared: from where the receipt put it (cheques in hand) into the bank. */
  async 'cheque.clear'(id, { t, map }) {
    const c = await Cheque.findByPk(id, { transaction: t });
    if (!c || c.direction !== 'received' || c.status !== 'cleared' || !c.depositBankAccountId) return null;
    const receipt = await CustomerReceipt.findByPk(c.sourceId, { paranoid: false, transaction: t });
    return {
      date: c.clearedAt,
      branchId: c.branchId,
      sourceNo: c.chequeNo,
      reference: c.sourceNo,
      narration: `Cheque ${c.chequeNo} cleared`,
      lines: [
        { accountId: await moneyAccount(c.depositBankAccountId, t), amount: D(c.amount) },
        { accountId: await methodAccount(receipt.paymentMethodId, map, t, 'in'), amount: D(c.amount).neg() },
      ],
    };
  },

  /** Labour and overhead of a finished operation (event "op:<operation id>"), charged to the order's WIP. */
  async 'manufacturing_order.op:*'(id, { t, event }) {
    const op = await MoOperation.findOne({ where: { id: event.split(':')[1], orderId: id }, transaction: t });
    const amount = D(op?.labourCost ?? 0).plus(op?.overheadCost ?? 0);
    if (!op || op.status !== 'done' || amount.isZero()) return null;
    const mo = await ManufacturingOrder.findByPk(id, { transaction: t });
    return {
      date: await localDate(mo.companyId, op.finishedAt ?? new Date()),
      branchId: mo.branchId,
      sourceNo: mo.number,
      narration: `${op.name} on ${mo.number}`,
      lines: [
        { key: 'wip', amount },
        { key: 'productionApplied', amount: amount.neg() },
      ],
    };
  },

  /** Closing an order: WIP left after the outputs (scrap, rounding) becomes production variance. */
  async 'manufacturing_order.close'(id, { t }) {
    const mo = await ManufacturingOrder.findByPk(id, { transaction: t });
    if (!mo || mo.status !== 'closed' || D(mo.varianceCost).isZero()) return null;
    return {
      date: await localDate(mo.companyId, mo.closedAt ?? new Date()),
      branchId: mo.branchId,
      sourceNo: mo.number,
      narration: `Production variance on ${mo.number}`,
      lines: [
        { key: 'productionVariance', amount: D(mo.varianceCost) },
        { key: 'wip', amount: D(mo.varianceCost).neg() },
      ],
    };
  },
};

/** Side effects tied to posting / unposting a document: the cheque register. */
const AFTER_POST = { customer_receipt: registerCheque, supplier_payment: registerCheque };
const AFTER_UNPOST = { customer_receipt: chequeSourceVoided, supplier_payment: chequeSourceVoided };

export const POSTING_EVENTS = Object.keys(BUILDERS);

/** Posting options from a request context: postSource('sales_invoice', id, by(ctx, t)). */
export const by = (ctx, t, extra = {}) => ({
  companyId: ctx.auth.companyId,
  userId: ctx.auth.userId,
  transaction: t,
  ...extra,
});

/**
 * Post the journal of a business event (inside the caller's transaction). Idempotent per
 * (source, event); returns the entry, or null when the event moves no money.
 */
export async function postSource(
  sourceType,
  sourceId,
  { companyId, userId = null, transaction: t, event = 'post', checkPeriod = true, accounts = null },
) {
  // "op:12" style events share one rule ("op:*").
  const build = BUILDERS[`${sourceType}.${event}`] ?? BUILDERS[`${sourceType}.${event.split(':')[0]}:*`];
  if (!build) throw new Error(`No posting rule for ${sourceType}.${event}`);
  await ensureLedger(companyId, t);
  const map = accounts ?? (await accountMap(companyId, t));
  const spec = await build(sourceId, { t, map, companyId, event });
  const entry = spec
    ? await postJournal({
        companyId,
        userId,
        entryType: 'auto',
        sourceType,
        sourceId,
        event,
        checkPeriod,
        accounts: map,
        transaction: t,
        ...spec,
      })
    : null;
  if (event === 'post')
    await AFTER_POST[sourceType]?.(sourceType, sourceId, { companyId, userId, transaction: t });
  return entry;
}

/** Undo a document's journals (cancel / void) with reversing entries dated today. */
export async function unpostSource(
  sourceType,
  sourceId,
  { companyId, userId = null, transaction: t, events },
) {
  const reversed = await reverseSource({
    companyId,
    userId,
    sourceType,
    sourceId,
    events,
    date: await localDate(companyId),
    transaction: t,
  });
  if (!events || events.includes('post'))
    await AFTER_UNPOST[sourceType]?.(sourceType, sourceId, { companyId, userId, transaction: t });
  return reversed;
}

/** Re-post an event whose amounts changed (e.g. a party's opening balance). */
export async function repostSource(sourceType, sourceId, opts) {
  await unpostSource(sourceType, sourceId, { ...opts, events: [opts.event ?? 'post'] });
  return postSource(sourceType, sourceId, opts);
}

/**
 * Value stock movements in the ledger: Inventory against the movement type's contra account
 * (COGS for sales, GRNI for purchases, transit for transfers, …). One entry per movement type,
 * so a document with stock in and out gets two. Goods receipts split the contra between GRNI
 * (goods value) and landed cost clearing.
 */
export async function postStockJournal({
  companyId,
  userId,
  date,
  reference,
  movements,
  transaction: t,
  checkPeriod = true,
  accounts = null,
}) {
  const byType = new Map();
  for (const m of movements) {
    if (!byType.has(m.movementType)) byType.set(m.movementType, []);
    byType.get(m.movementType).push(m);
  }
  await ensureLedger(companyId, t);
  const map = accounts ?? (await accountMap(companyId, t));
  const entries = [];
  for (const [type, rows] of byType) {
    const contra = MOVEMENT_CONTRA_KEY[type] ?? 'stockAdjustment';
    const lines = [];
    const split =
      type === 'purchase_receipt' && reference.type === 'goods_receipt'
        ? new Map(
            (
              await GoodsReceiptItem.findAll({
                where: { id: rows.map((m) => m.referenceItemId).filter(Boolean) },
                attributes: ['id', 'lineValue', 'landedCost'],
                transaction: t,
              })
            ).map((i) => [String(i.id), i]),
          )
        : null;
    for (const m of rows) {
      const value = D(m.totalCost);
      if (value.isZero()) continue;
      const branchId = m.branchId;
      lines.push({ key: 'inventory', amount: value, branchId });
      const item = split?.get(String(m.referenceItemId));
      if (item && D(item.landedCost).gt(0)) {
        lines.push({ key: 'landedCost', amount: D(item.landedCost).neg(), branchId });
        lines.push({ key: contra, amount: value.minus(item.landedCost).neg(), branchId });
      } else {
        lines.push({ key: contra, amount: value.neg(), branchId });
      }
    }
    if (!lines.length) continue;
    const entry = await postJournal({
      companyId,
      userId,
      date,
      entryType: 'auto',
      sourceType: reference.type,
      sourceId: reference.id,
      sourceNo: reference.no ?? null,
      event: `stock:${type}`,
      narration: `Stock ${type.replaceAll('_', ' ')}${reference.no ? ` — ${reference.no}` : ''}`,
      lines,
      accounts: map,
      checkPeriod,
      // One entry per document and movement type, posted once (the backfill selects only missing ones).
      checkExisting: false,
      transaction: t,
    });
    if (entry) entries.push(entry);
  }
  return entries;
}
