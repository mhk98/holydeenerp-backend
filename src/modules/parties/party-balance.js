import Decimal from 'decimal.js';

/**
 * A party's opening balance as seen by one role, so it is counted exactly once:
 *   customer role — receivable (positive = the customer owes us)
 *   supplier role — payable (positive = we owe the supplier)
 * A party with only one role carries the whole balance in that role (a customer's credit opening is an
 * advance). A party that is both customer and supplier carries a debit balance as a receivable and a
 * credit balance as a payable — never both.
 *
 * Needs openingBalance, openingBalanceType, isCustomer and isSupplier on `party`.
 */
export function roleOpening(party, role) {
  const amount = new Decimal(party.openingBalance ?? 0);
  const debit = party.openingBalanceType === 'debit';
  if (role === 'customer') {
    if (party.isSupplier && !debit) return new Decimal(0);
    return debit ? amount : amount.neg();
  }
  if (party.isCustomer && debit) return new Decimal(0);
  return debit ? amount.neg() : amount;
}

/** Attributes roleOpening() reads. */
export const OPENING_ATTRIBUTES = ['openingBalance', 'openingBalanceType', 'isCustomer', 'isSupplier'];
