import { z } from 'zod';

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'DD-MM-YYYY'];
export const THEME_COLORS = ['neutral', 'blue', 'emerald', 'violet', 'orange', 'rose'];

/**
 * Settings groups. Each is stored as one JSON document; `defaults` fill anything not saved yet.
 * scope 'company' = per tenant, 'system' = whole installation (companyId NULL).
 * `secrets` are encrypted at rest and never returned by the API.
 */
export const SETTING_GROUPS = {
  financial: {
    scope: 'company',
    schema: z.object({
      baseCurrency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/, 'Choose a currency')
        .toUpperCase(),
      multiCurrency: z.boolean(),
      fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
      fiscalYearStartDay: z.coerce.number().int().min(1).max(28),
      amountDecimals: z.coerce.number().int().min(0).max(4),
      quantityDecimals: z.coerce.number().int().min(0).max(4),
      pricesIncludeTax: z.boolean(),
    }),
    // Bangladesh fiscal year runs July–June.
    defaults: {
      baseCurrency: 'BDT',
      multiCurrency: true,
      fiscalYearStartMonth: 7,
      fiscalYearStartDay: 1,
      amountDecimals: 2,
      quantityDecimals: 2,
      pricesIncludeTax: false,
    },
  },

  system: {
    scope: 'company',
    schema: z.object({
      dateFormat: z.enum(DATE_FORMATS),
      timeFormat: z.enum(['12h', '24h']),
      timezone: z.string().refine((tz) => TIMEZONES.has(tz), 'Choose a valid timezone'),
      language: z.enum(['en', 'bn']),
      themeColor: z.enum(THEME_COLORS),
    }),
    defaults: {
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '12h',
      timezone: 'Asia/Dhaka',
      language: 'en',
      themeColor: 'neutral',
    },
  },

  smtp: {
    scope: 'company',
    secrets: ['password'],
    schema: z.object({
      enabled: z.boolean(),
      host: z.string().trim().max(191),
      port: z.coerce.number().int().min(1).max(65535),
      secure: z.boolean(),
      username: z.string().trim().max(191),
      password: z.string().max(500),
      fromName: z.string().trim().max(150),
      fromEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]),
    }),
    defaults: {
      enabled: false,
      host: '',
      port: 587,
      secure: false,
      username: '',
      password: '',
      fromName: '',
      fromEmail: '',
    },
    /** Cross-field rule checked on save. */
    refine: (v) =>
      v.enabled && (!v.host || !v.fromEmail) ? 'Host and From email are required when SMTP is enabled' : null,
  },

  inventory: {
    scope: 'company',
    schema: z.object({
      /** How stock-out cost is measured. Cost layers are always kept, so switching is safe. */
      costingMethod: z.enum(['fifo', 'weighted_average']),
      /** Allow issuing more than is on hand (never for batch- or serial-tracked products). */
      allowNegativeStock: z.boolean(),
      /** Adjustments, damage/scrap, opening stock and count postings wait for inventory.approve. */
      requireApproval: z.boolean(),
      nearExpiryDays: z.coerce.number().int().min(1).max(365),
      /** No stock-out for this many days → slow-moving; deadStockDays → dead stock. */
      slowMovingDays: z.coerce.number().int().min(1).max(730),
      deadStockDays: z.coerce.number().int().min(1).max(1825),
    }),
    defaults: {
      costingMethod: 'weighted_average',
      allowNegativeStock: false,
      requireApproval: true,
      nearExpiryDays: 30,
      slowMovingDays: 90,
      deadStockDays: 180,
    },
    refine: (v) =>
      v.deadStockDays <= v.slowMovingDays ? 'Dead stock days must be more than slow-moving days' : null,
  },

  sales: {
    scope: 'company',
    schema: z.object({
      /** Round document totals to this step (the difference is shown as "round off"). */
      roundTo: z.enum(['none', '0.5', '1', '5', '10']),
      roundingMode: z.enum(['nearest', 'up', 'down']),
      /** Block orders/invoices above the customer's credit limit (sales.approve can override with a reason). */
      creditCheck: z.boolean(),
      defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365),
      quotationValidityDays: z.coerce.number().int().min(1).max(365),
      defaultTerms: z.string().max(5000),
      /** Automatic payment reminders (sent daily at 09:00 Asia/Dhaka to the customer's email). */
      remindersEnabled: z.boolean(),
      reminderDaysBefore: z.array(z.coerce.number().int().min(1).max(60)).max(5),
      reminderDaysAfter: z.array(z.coerce.number().int().min(1).max(365)).max(5),
    }),
    defaults: {
      roundTo: '1',
      roundingMode: 'nearest',
      creditCheck: true,
      defaultPaymentTermsDays: 15,
      quotationValidityDays: 15,
      defaultTerms:
        'Goods once sold are returnable within 7 days with the invoice. Please pay by the due date.',
      remindersEnabled: false,
      reminderDaysBefore: [3],
      reminderDaysAfter: [1, 7, 30],
    },
  },

  pos: {
    scope: 'company',
    schema: z.object({
      /** Notes and coins counted when a register is closed (largest first). */
      denominations: z.array(z.coerce.number().positive()).min(1).max(20),
      /** Quick cash buttons on the payment screen. */
      quickCash: z.array(z.coerce.number().positive()).max(8),
      /** Cashiers may change the unit price (otherwise only users with pos.update). */
      allowPriceEdit: z.boolean(),
      /** Largest line / cart discount a cashier may give, in percent. */
      maxDiscountPercent: z.coerce.number().min(0).max(100),
      /** Print the receipt as soon as a sale is completed. */
      autoPrint: z.boolean(),
      receiptFooter: z.string().max(500),
      /** Keep selling while offline (sales are queued and synced). */
      offlineEnabled: z.boolean(),
    }),
    defaults: {
      denominations: [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1],
      quickCash: [100, 200, 500, 1000, 2000, 5000],
      allowPriceEdit: false,
      maxDiscountPercent: 10,
      autoPrint: true,
      receiptFooter: 'Thank you for shopping with us!',
      offlineEnabled: true,
    },
  },

  purchase: {
    scope: 'company',
    schema: z.object({
      /**
       * Purchase order approval levels. An order needs every level whose minAmount is at or below
       * its total, in order. roleId limits who may approve a level (null = anyone with purchase.approve).
       */
      approvalLevels: z
        .array(
          z.object({
            name: z.string().trim().min(1, 'Name is required').max(100),
            minAmount: z
              .union([z.string(), z.number()])
              .transform((v) => String(v).trim())
              .refine((v) => /^\d+(\.\d{1,4})?$/.test(v), 'Enter an amount'),
            roleId: z.coerce
              .string()
              .regex(/^\d+$/)
              .nullish()
              .transform((v) => v ?? null),
          }),
        )
        .max(5, 'At most 5 levels'),
      /** Requisitions wait for purchase.approve before they can be ordered. */
      requisitionApproval: z.boolean(),
      /** How much more than ordered a goods receipt may take in (percent of the ordered quantity). */
      overReceiptPercent: z.coerce.number().min(0).max(100),
      defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365),
      defaultTerms: z.string().max(5000),
    }),
    defaults: {
      approvalLevels: [
        { name: 'Purchase manager', minAmount: '0', roleId: null },
        { name: 'Management', minAmount: '200000', roleId: null },
      ],
      requisitionApproval: true,
      overReceiptPercent: 0,
      defaultPaymentTermsDays: 30,
      defaultTerms: 'Please quote our PO number on the delivery challan and invoice.',
    },
    refine: (v) => {
      const amounts = v.approvalLevels.map((l) => Number(l.minAmount));
      return amounts.some((a, i) => i > 0 && a <= amounts[i - 1])
        ? 'Approval levels must have increasing minimum amounts'
        : null;
    },
  },

  backup: {
    scope: 'system',
    schema: z.object({
      scheduleEnabled: z.boolean(),
      frequency: z.enum(['daily', 'weekly']),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm'),
      /** 0 = Sunday … 6 = Saturday (weekly only). */
      weekday: z.coerce.number().int().min(0).max(6),
      retention: z.coerce.number().int().min(1).max(90),
    }),
    defaults: { scheduleEnabled: false, frequency: 'daily', time: '02:00', weekday: 5, retention: 7 },
  },

  /** Account mapping overrides (mapping key → account id); edited through /accounting/mapping. */
  accounting: {
    scope: 'company',
    schema: z.object({
      accounts: z.record(z.string(), z.coerce.string().regex(/^\d+$/).nullable()),
    }),
    defaults: { accounts: {} },
  },
};

export const GROUP_NAMES = Object.keys(SETTING_GROUPS);
/** Groups editable through /settings/preferences/:group (backup has its own endpoints). */
export const PREFERENCE_GROUPS = ['financial', 'system', 'smtp', 'inventory', 'purchase', 'sales', 'pos'];
