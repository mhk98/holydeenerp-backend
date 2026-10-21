import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/db.js';
import { AppError } from './AppError.js';

/**
 * Block deleting a record that other records still use.
 *
 *   await assertUnused(unit.id, [
 *     { table: 'products', column: 'base_unit_id', label: 'product', paranoid: true },
 *     { table: 'sales_invoice_items', column: 'unit_id', label: 'document line' },
 *   ], { what: 'This unit', transaction: t });
 *
 * Throws 409 "This unit is used by 3 product(s); deactivate it instead." for the first table that
 * references the id. `paranoid` skips soft-deleted rows. Table and column names are constants from
 * the calling code (never request input), so building them into the SQL is safe; the id is bound.
 */
export async function assertUnused(id, refs, { what, hint = 'deactivate it instead', transaction } = {}) {
  for (const ref of refs) {
    const [row] = await sequelize.query(
      `SELECT COUNT(*) AS n FROM \`${ref.table}\` WHERE \`${ref.column}\` = :id${
        ref.paranoid ? ' AND deleted_at IS NULL' : ''
      }${ref.where ? ` AND ${ref.where}` : ''}`,
      { replacements: { id }, type: QueryTypes.SELECT, transaction },
    );
    const n = Number(row.n);
    if (n) throw AppError.conflict(`${what} is used by ${n} ${ref.label}(s); ${hint}`);
  }
}

/** Line tables of every sales / purchase / inventory document (for product-level references). */
export const DOCUMENT_LINE_TABLES = [
  'sales_quotation_items',
  'sales_order_items',
  'delivery_challan_items',
  'sales_invoice_items',
  'sales_return_items',
  'purchase_requisition_items',
  'purchase_rfq_items',
  'purchase_order_items',
  'goods_receipt_items',
  'supplier_bill_items',
  'purchase_return_items',
  'stock_adjustment_items',
  'stock_transfer_items',
];
