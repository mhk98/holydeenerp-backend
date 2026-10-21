'use strict';
/**
 * Purchase setup for Holydeen Trading Ltd.: number series for requisitions (PRQ-), RFQs (RFQ-)
 * and goods receipts (GRN-), plus purchase orders, bills, returns and payment vouchers when an
 * older installation lacks them. Existing series are left alone.
 */
const COMPANY = 'HOLYDEEN';

const SERIES = [
  ['purchase_requisition', 'Purchase requisition', 'PRQ-{YYYY}-'],
  ['purchase_rfq', 'Request for quotation', 'RFQ-{YYYY}-'],
  ['purchase_order', 'Purchase order', 'PO-{YYYY}-'],
  ['goods_receipt', 'Goods received note', 'GRN-{YYYY}-'],
  ['purchase_bill', 'Purchase bill', 'BILL-{YYYY}-'],
  ['purchase_return', 'Purchase return', 'PR-{YYYY}-'],
  ['payment_voucher', 'Payment voucher', 'PV-{YYYY}-'],
];

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    const now = new Date();
    for (const [docType, name, prefix] of SERIES) {
      const [[exists]] = await db.query(
        'SELECT id FROM document_sequences WHERE company_id = ? AND doc_type = ? LIMIT 1',
        {
          replacements: [company.id, docType],
        },
      );
      if (exists) continue;
      await queryInterface.bulkInsert('document_sequences', [
        {
          company_id: company.id,
          branch_id: null,
          doc_type: docType,
          name,
          prefix,
          suffix: '',
          padding: 5,
          next_number: 1,
          reset_yearly: true,
          current_year: now.getFullYear(),
          is_active: true,
          created_at: now,
          updated_at: now,
        },
      ]);
    }
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    await db.query(
      "DELETE FROM document_sequences WHERE doc_type IN ('purchase_requisition', 'purchase_rfq', 'goods_receipt')",
    );
  },
};
