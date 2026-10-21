import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import {
  CustomerReceipt,
  PaymentMethod,
  PosCashMovement,
  PosRegister,
  PosSession,
  SalesInvoice,
  SalesReturn,
} from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';
import { by, postSource } from '../accounting/posting.service.js';
import {
  D,
  findRegister,
  findSession,
  fixed,
  invalid,
  openSessionOf,
  posSettings,
  userRef,
} from './pos.common.js';

/**
 * Register sessions (cashier shifts).
 *   open (opening float) → sales, refunds, cash in / out → close (counted by denomination)
 * Expected cash = opening + cash received − cash refunded + cash in − cash out; the difference to
 * the count is the variance. The X report is the running summary; closing stores it as the Z report.
 */

const LIST_OPTIONS = {
  sortable: ['number', 'openedAt', 'closedAt', 'variance'],
  searchable: ['number'],
  filterable: ['registerId', 'status', 'openedBy'],
  defaultSort: '-openedAt',
};

const sessionIncludes = () => [
  { model: PosRegister, as: 'register', attributes: ['id', 'name', 'code', 'warehouseId', 'branchId'] },
  userRef('opener'),
  userRef('closer'),
];

export async function listSessions(ctx, query) {
  const q = parseListQuery(query, LIST_OPTIONS);
  const where = {
    ...q.where,
    companyId: ctx.auth.companyId,
    branchId: ctx.branchIds.length ? ctx.branchIds : [0],
  };
  if (query.from || query.to) {
    where.openedAt = {
      ...(query.from && { [Op.gte]: new Date(`${query.from}T00:00:00`) }),
      ...(query.to && { [Op.lte]: new Date(`${query.to}T23:59:59`) }),
    };
  }
  const { rows, count } = await PosSession.findAndCountAll({
    where,
    include: sessionIncludes(),
    order: q.order,
    limit: q.limit,
    offset: q.offset,
    distinct: true,
  });
  return { rows: rows.map((r) => r.toJSON()), count, page: q.page, limit: q.limit };
}

/** Running totals of a session (the X report). */
export async function sessionReport(session, t) {
  const where = { posSessionId: session.id };
  const [sales, payments, returns, refunds, movements, items] = await Promise.all([
    SalesInvoice.findOne({
      where: { ...where, status: { [Op.in]: ['unpaid', 'partially_paid', 'paid'] } },
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('subtotal')), 0), 'gross'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('discount_total')), 0), 'discounts'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('tax_total')), 0), 'tax'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('round_off')), 0), 'roundOff'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'total'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('change_amount')), 0), 'change'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('cost_total')), 0), 'cost'],
      ],
      raw: true,
      transaction: t,
    }),
    CustomerReceipt.findAll({
      where: { ...where, status: 'posted' },
      attributes: ['paymentMethodId', [sequelize.fn('SUM', sequelize.col('amount')), 'amount']],
      group: ['paymentMethodId'],
      raw: true,
      transaction: t,
    }),
    SalesReturn.findOne({
      where: { ...where, status: 'posted' },
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        [sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('total')), 0), 'total'],
      ],
      raw: true,
      transaction: t,
    }),
    SalesReturn.findAll({
      where: { ...where, status: 'posted', refundedAmount: { [Op.gt]: 0 } },
      attributes: ['refundMethodId', [sequelize.fn('SUM', sequelize.col('refunded_amount')), 'amount']],
      group: ['refundMethodId'],
      raw: true,
      transaction: t,
    }),
    PosCashMovement.findAll({
      where: { sessionId: session.id },
      attributes: ['type', [sequelize.fn('SUM', sequelize.col('amount')), 'amount']],
      group: ['type'],
      raw: true,
      transaction: t,
    }),
    sequelize.query(
      `SELECT COALESCE(SUM(ii.base_quantity), 0) AS quantity, COUNT(DISTINCT ii.product_id) AS products
         FROM sales_invoice_items ii JOIN sales_invoices i ON i.id = ii.invoice_id
        WHERE i.pos_session_id = ? AND i.status IN ('unpaid', 'partially_paid', 'paid')`,
      { replacements: [session.id], type: QueryTypes.SELECT, transaction: t },
    ),
  ]);
  const methodIds = [
    ...new Set([...payments.map((p) => p.paymentMethodId), ...refunds.map((r) => r.refundMethodId)]),
  ];
  const methods = await PaymentMethod.findAll({
    where: { id: methodIds.length ? methodIds : [0] },
    attributes: ['id', 'name', 'type'],
    transaction: t,
  });
  const methodOf = new Map(methods.map((m) => [String(m.id), m]));
  const byMethod = new Map();
  const row = (id) => {
    const key = String(id);
    if (!byMethod.has(key)) {
      const m = methodOf.get(key);
      byMethod.set(key, {
        methodId: key,
        name: m?.name ?? '—',
        type: m?.type ?? 'other',
        received: D(0),
        refunded: D(0),
      });
    }
    return byMethod.get(key);
  };
  for (const p of payments) row(p.paymentMethodId).received = D(p.amount);
  for (const r of refunds) row(r.refundMethodId).refunded = D(r.amount);
  const cashIn = D(movements.find((m) => m.type === 'in')?.amount ?? 0);
  const cashOut = D(movements.find((m) => m.type === 'out')?.amount ?? 0);
  const cashMethods = [...byMethod.values()].filter((m) => m.type === 'cash');
  const cashReceived = cashMethods.reduce((s, m) => s.plus(m.received), D(0));
  const cashRefunded = cashMethods.reduce((s, m) => s.plus(m.refunded), D(0));
  const expectedCash = D(session.openingCash)
    .plus(cashReceived)
    .minus(cashRefunded)
    .plus(cashIn)
    .minus(cashOut);
  const received = [...byMethod.values()].reduce((s, m) => s.plus(m.received), D(0));

  return {
    sales: {
      count: Number(sales.count),
      gross: fixed(sales.gross),
      discounts: fixed(sales.discounts),
      tax: fixed(sales.tax),
      roundOff: fixed(sales.roundOff),
      total: fixed(sales.total),
      cost: fixed(sales.cost),
      changeGiven: fixed(sales.change),
      onAccount: fixed(D(sales.total).minus(received).lt(0) ? 0 : D(sales.total).minus(received)),
      itemsQuantity: fixed(items[0].quantity),
      products: Number(items[0].products),
    },
    returns: { count: Number(returns.count), total: fixed(returns.total) },
    payments: [...byMethod.values()].map((m) => ({
      ...m,
      received: fixed(m.received),
      refunded: fixed(m.refunded),
      net: fixed(m.received.minus(m.refunded)),
    })),
    cash: {
      opening: fixed(session.openingCash),
      received: fixed(cashReceived),
      refunded: fixed(cashRefunded),
      cashIn: fixed(cashIn),
      cashOut: fixed(cashOut),
      expected: fixed(expectedCash),
    },
  };
}

export async function getSession(ctx, id) {
  const session = await findSession(ctx, id);
  const full = await PosSession.findByPk(session.id, {
    include: [
      ...sessionIncludes(),
      {
        model: PosCashMovement,
        as: 'cashMovements',
        separate: true,
        include: [userRef('creator')],
        order: [['id', 'ASC']],
      },
    ],
  });
  const json = full.toJSON();
  // A closed session shows its stored Z report; an open one the live X report.
  return {
    ...json,
    report: session.status === 'closed' && json.summary ? json.summary : await sessionReport(session),
  };
}

/** The open session of a register (null when it is closed). */
export async function currentSession(ctx, registerId) {
  const register = await findRegister(ctx, registerId);
  const session = await openSessionOf(register.id);
  return session ? getSession(ctx, session.id) : null;
}

export async function openSession(ctx, { registerId, openingCash, notes }) {
  const id = await sequelize.transaction(async (t) => {
    // Locking the register serialises two cashiers opening it at once.
    const register = await findRegister(ctx, registerId, t, { lock: true });
    if (await openSessionOf(register.id, t))
      throw AppError.conflict(`${register.name} is already open — close that session first`);
    const seq =
      (await PosSession.count({ where: { registerId: register.id }, transaction: t, paranoid: false })) + 1;
    const session = await PosSession.create(
      {
        companyId: ctx.auth.companyId,
        branchId: register.branchId,
        registerId: register.id,
        number: `${register.code}-Z${String(seq).padStart(5, '0')}`,
        status: 'open',
        openedBy: ctx.auth.userId,
        openedAt: new Date(),
        openingCash: fixed(openingCash ?? 0),
        openingNotes: notes ?? null,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    return session.id;
  });
  return getSession(ctx, id);
}

/** An open session to sell on; used by sales, returns and cash movements. */
export async function lockOpenSession(ctx, id, t) {
  const session = await findSession(ctx, id, t, { lock: true });
  if (session.status !== 'open') throw invalid('sessionId', 'This register session is closed');
  return session;
}

export async function addCashMovement(ctx, id, { type, amount, reason }) {
  await sequelize.transaction(async (t) => {
    const session = await lockOpenSession(ctx, id, t);
    if (type === 'out') {
      const { cash } = await sessionReport(session, t);
      if (D(amount).gt(cash.expected))
        throw invalid('amount', `Only ${D(cash.expected).toFixed(2)} should be in the drawer`);
    }
    await PosCashMovement.create(
      {
        companyId: ctx.auth.companyId,
        sessionId: session.id,
        type,
        amount: fixed(amount),
        reason,
        createdBy: ctx.auth.userId,
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
  });
  return getSession(ctx, id);
}

/** Close with the counted cash: { denominations: { "1000": 3, "500": 1, … } } (or a plain countedCash). */
export async function closeSession(ctx, id, { denominations, countedCash, notes }) {
  await sequelize.transaction(async (t) => {
    const session = await lockOpenSession(ctx, id, t);
    const { denominations: allowed } = await posSettings(ctx.auth.companyId, t);
    let counted = D(0);
    const counts = {};
    if (denominations) {
      for (const [value, count] of Object.entries(denominations)) {
        if (!allowed.map(String).includes(String(Number(value))))
          throw invalid(`denominations.${value}`, `${value} is not a configured denomination`);
        if (!count) continue;
        counts[String(Number(value))] = count;
        counted = counted.plus(D(value).times(count));
      }
    } else {
      counted = D(countedCash ?? 0);
    }
    const report = await sessionReport(session, t);
    const variance = counted.minus(report.cash.expected);
    const closedAt = new Date();
    await session.update(
      {
        status: 'closed',
        closedBy: ctx.auth.userId,
        closedAt,
        expectedCash: report.cash.expected,
        countedCash: fixed(counted),
        variance: fixed(variance),
        denominations: denominations ? counts : null,
        closingNotes: notes ?? null,
        summary: {
          ...report,
          cash: { ...report.cash, counted: fixed(counted), variance: fixed(variance) },
          closedAt,
        },
        updatedBy: ctx.auth.userId,
      },
      { transaction: t },
    );
    await postSource('pos_session', session.id, by(ctx, t, { event: 'variance' }));
  });
  return getSession(ctx, id);
}
