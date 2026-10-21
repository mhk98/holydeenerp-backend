import { Op } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { Party, PartyAddress, PartyGroup } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { createCrudService } from '../../utils/crud.js';
import { parseListQuery } from '../../utils/pagination.js';
import { retiredValue } from '../../utils/slug.js';
import { assertUnused } from '../../utils/usage.js';
import { nextNumber } from '../sequences/sequences.service.js';
import { D } from '../purchase/purchase.common.js';
import { by, repostSource } from '../accounting/posting.service.js';

/**
 * Customers and suppliers are views over the same `parties` table.
 * ROLE describes what each view filters on and which group column it owns.
 */
const docs = (column, tables) =>
  tables.map((table) => ({ table, column, label: 'document', paranoid: true }));

export const ROLE = {
  customer: {
    flag: 'isCustomer',
    other: 'isSupplier',
    groupField: 'customerGroupId',
    codeSeries: 'customer_code',
    /** Records that use a customer (deleting it is refused while any exist). */
    documents: [
      ...docs('customer_id', [
        'sales_quotations',
        'sales_orders',
        'delivery_challans',
        'sales_invoices',
        'customer_receipts',
        'sales_returns',
        'recurring_invoices',
        'pos_held_orders',
      ]),
      { table: 'pos_registers', column: 'default_customer_id', label: 'POS register', paranoid: true },
    ],
  },
  supplier: {
    flag: 'isSupplier',
    other: 'isCustomer',
    groupField: 'supplierGroupId',
    codeSeries: 'supplier_code',
    documents: [
      ...docs('supplier_id', [
        'purchase_orders',
        'goods_receipts',
        'supplier_bills',
        'supplier_payments',
        'purchase_returns',
      ]),
      { table: 'purchase_rfq_suppliers', column: 'supplier_id', label: 'RFQ' },
    ],
  },
};

const LIST_OPTIONS = {
  sortable: ['name', 'code', 'creditLimit', 'createdAt'],
  searchable: ['name', 'code', 'phone', 'email', 'contactPerson'],
  filterable: ['isActive'],
  defaultSort: 'name',
};

const include = () => [
  { model: PartyGroup, as: 'customerGroup', attributes: ['id', 'name', 'code'] },
  { model: PartyGroup, as: 'supplierGroup', attributes: ['id', 'name', 'code'] },
  { model: PartyAddress, as: 'addresses' },
];

function serialize(party, type) {
  const json = party.toJSON();
  const addresses = [...(json.addresses ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const role = ROLE[type];
  return {
    ...json,
    addresses,
    group: type === 'customer' ? json.customerGroup : json.supplierGroup,
    groupId: json[role.groupField] ? String(json[role.groupField]) : null,
    defaultAddress: addresses[0] ?? null,
    alsoOtherRole: Boolean(json[role.other]),
  };
}

export function partyService(type) {
  const role = ROLE[type];
  const label = type === 'customer' ? 'Customer' : 'Supplier';
  const notFound = () => AppError.notFound(`${label} not found`);

  async function find(ctx, id, options = {}) {
    const party = await Party.findOne({
      where: { id, companyId: ctx.auth.companyId, [role.flag]: true },
      ...options,
    });
    if (!party) throw notFound();
    return party;
  }

  async function get(ctx, id) {
    return serialize(await find(ctx, id, { include: include() }), type);
  }

  async function list(ctx, query) {
    const q = parseListQuery(query, LIST_OPTIONS);
    const where = { ...q.where, companyId: ctx.auth.companyId, [role.flag]: true };
    if (query.groupId) where[role.groupField] = query.groupId;
    const { rows, count } = await Party.findAndCountAll({
      where,
      include: include(),
      order: q.order,
      limit: q.limit,
      offset: q.offset,
      distinct: true,
    });
    return { rows: rows.map((r) => serialize(r, type)), count, page: q.page, limit: q.limit };
  }

  async function save(ctx, id, input, transaction) {
    const run = async (t) => {
      const existing = id ? await find(ctx, id, { transaction: t, lock: t.LOCK.UPDATE }) : null;
      const { addresses, groupId, alsoOtherRole, code, ...fields } = input;

      if (groupId) {
        const ok = await PartyGroup.count({
          where: { id: groupId, companyId: ctx.auth.companyId, type },
          transaction: t,
        });
        if (!ok)
          throw AppError.unprocessable('Validation failed', [
            { field: 'groupId', message: 'Group not found' },
          ]);
      }

      const finalCode =
        code?.toUpperCase() ||
        existing?.code ||
        (await nextNumber({ companyId: ctx.auth.companyId, docType: role.codeSeries, transaction: t }));
      const clash = await Party.count({
        where: {
          companyId: ctx.auth.companyId,
          code: finalCode,
          ...(existing && { id: { [Op.ne]: existing.id } }),
        },
        transaction: t,
      });
      if (clash)
        throw AppError.conflict(`${label} code already in use`, [
          { field: 'code', message: 'Already in use' },
        ]);

      const patch = {
        ...fields,
        code: finalCode,
        [role.flag]: true,
        ...(groupId !== undefined && { [role.groupField]: groupId ?? null }),
        ...(alsoOtherRole !== undefined && { [role.other]: alsoOtherRole }),
        updatedBy: ctx.auth.userId,
      };

      let party;
      const ledgerFields = (p) =>
        p ? [D(p.openingBalance).toFixed(4), p.openingBalanceType, p.isCustomer, p.isSupplier].join('|') : '';
      const before = ledgerFields(existing);
      const hadOpening = Boolean(existing) && !D(existing.openingBalance).isZero();
      if (existing) {
        await existing.update(patch, { transaction: t });
        party = existing;
      } else {
        party = await Party.create(
          { ...patch, companyId: ctx.auth.companyId, createdBy: ctx.auth.userId },
          { transaction: t },
        );
      }
      // The opening balance lives in the ledger too (AR / AP against opening balance equity).
      const hasOpening = !D(party.openingBalance).isZero();
      if ((hadOpening || hasOpening) && ledgerFields(party) !== before) {
        await repostSource('party', party.id, by(ctx, t, { event: 'opening' }));
      }

      if (addresses) {
        await PartyAddress.destroy({ where: { partyId: party.id }, transaction: t });
        const defaultIndex = Math.max(
          0,
          addresses.findIndex((a) => a.isDefault),
        );
        await PartyAddress.bulkCreate(
          addresses.map((a, i) => ({
            ...a,
            country: a.country || 'Bangladesh',
            partyId: party.id,
            isDefault: i === defaultIndex,
          })),
          { transaction: t },
        );
      }
      return party.id;
    };
    const partyId = transaction ? await run(transaction) : await sequelize.transaction(run);
    return transaction ? partyId : get(ctx, partyId);
  }

  /** Removing a customer that is also a supplier only drops the customer role. */
  async function remove(ctx, id) {
    await sequelize.transaction(async (t) => {
      const party = await find(ctx, id, { transaction: t, lock: t.LOCK.UPDATE });
      const what = `${label} ${party.name}`;
      // Documents of this role keep the party; it can be deactivated instead.
      await assertUnused(party.id, role.documents, { what, transaction: t });
      if (party[role.other]) {
        await party.update(
          { [role.flag]: false, [role.groupField]: null, updatedBy: ctx.auth.userId },
          { transaction: t },
        );
        return;
      }
      if (!D(party.openingBalance).isZero())
        throw AppError.conflict(`${what} has an opening balance; deactivate it instead`);
      await assertUnused(party.id, [{ table: 'journal_lines', column: 'party_id', label: 'journal line' }], {
        what,
        transaction: t,
      });
      await party.update(
        { code: retiredValue(party.code, party.id, 30), updatedBy: ctx.auth.userId },
        { transaction: t },
      );
      await party.destroy({ transaction: t });
    });
  }

  return { list, get, save, remove, find };
}

export const customers = partyService('customer');
export const suppliers = partyService('supplier');

/** Customer groups / supplier groups. */
export function groupCrud(type) {
  return createCrudService({
    model: PartyGroup,
    label: type === 'customer' ? 'Customer group' : 'Supplier group',
    uniqueFields: ['code'],
    scopeWhere: () => ({ type }),
    uniqueScope: () => ({ type }),
    listOptions: {
      sortable: ['name', 'code'],
      searchable: ['name', 'code'],
      filterable: ['isActive'],
      defaultSort: 'name',
    },
    beforeSave: async (ctx, data) => {
      if (data.code) data.code = data.code.toUpperCase();
      return { ...data, type };
    },
    beforeDelete: async (ctx, group, t) => {
      const used = await Party.count({ where: { [ROLE[type].groupField]: group.id }, transaction: t });
      if (used) throw AppError.conflict(`${used} ${type}(s) are in this group. Move them first.`);
    },
  });
}

export const customerGroups = groupCrud('customer');
export const supplierGroups = groupCrud('supplier');
