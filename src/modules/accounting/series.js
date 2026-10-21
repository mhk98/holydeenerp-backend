import { DocumentSequence } from '../../models.js';
import { nextNumber } from '../sequences/sequences.service.js';

/** Number series the accounting documents use (created on first use; editable in Settings → Numbering). */
export const ACCOUNTING_SERIES = {
  journal_entry: ['Journal entry', 'JV-{YYYY}-'],
  bank_receipt: ['Bank / cash receipt voucher', 'RV-{YYYY}-'],
  bank_payment: ['Bank / cash payment voucher', 'BPV-{YYYY}-'],
  contra_voucher: ['Contra voucher', 'CV-{YYYY}-'],
  expense: ['Expense', 'EXP-{YYYY}-'],
  production_order: ['Production order', 'MO-{YYYY}-'],
};

/** Next number of a series, creating the company-wide series (from ACCOUNTING_SERIES) the first time. */
export async function nextAccountingNumber({
  companyId,
  docType,
  branchId = null,
  userId = null,
  transaction: t,
}) {
  const [name, prefix] = ACCOUNTING_SERIES[docType];
  if (!(await DocumentSequence.count({ where: { companyId, docType }, transaction: t }))) {
    await DocumentSequence.create(
      { companyId, docType, name, prefix, padding: 5, createdBy: userId, updatedBy: userId },
      { transaction: t },
    );
  }
  return nextNumber({ companyId, docType, branchId, transaction: t });
}
