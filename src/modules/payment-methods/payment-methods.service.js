import { PaymentMethod } from '../../models.js';
import { createCrudService } from '../../utils/crud.js';
import { assertUnused } from '../../utils/usage.js';

export const paymentMethodCrud = createCrudService({
  model: PaymentMethod,
  label: 'Payment method',
  uniqueFields: ['code'],
  listOptions: {
    sortable: ['name', 'sortOrder', 'type', 'createdAt'],
    searchable: ['name', 'code', 'provider'],
    filterable: ['type', 'isActive'],
    defaultSort: 'sortOrder',
  },
  beforeSave: async (ctx, data) => {
    if (data.code) data.code = data.code.toUpperCase();
    return data;
  },
  beforeDelete: (ctx, method, t) =>
    assertUnused(
      method.id,
      [
        { table: 'customer_receipts', column: 'payment_method_id', label: 'money receipt', paranoid: true },
        {
          table: 'supplier_payments',
          column: 'payment_method_id',
          label: 'supplier payment',
          paranoid: true,
        },
        { table: 'sales_returns', column: 'refund_method_id', label: 'refund', paranoid: true },
      ],
      { what: `Payment method ${method.name}`, transaction: t },
    ),
});
