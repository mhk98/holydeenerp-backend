'use strict';

/**
 * Settings demo data for Holydeen Trading Ltd.: warehouses, currencies with BDT exchange rates,
 * Bangladesh VAT/SD rates and groups, number series, units, payment methods and print templates.
 */

const COMPANY = 'HOLYDEEN';
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const CURRENCIES = [
  // code, name, symbol, decimals, base, [rate 30 days ago, rate today]
  ['BDT', 'Bangladeshi Taka', '৳', 2, true, null],
  ['USD', 'US Dollar', '$', 2, false, ['121.500000', '122.500000']],
  ['EUR', 'Euro', '€', 2, false, ['131.200000', '133.100000']],
  ['GBP', 'British Pound', '£', 2, false, ['153.400000', '155.250000']],
  ['INR', 'Indian Rupee', '₹', 2, false, ['1.455000', '1.462000']],
  ['CNY', 'Chinese Yuan', '¥', 2, false, ['16.810000', '16.920000']],
  ['SAR', 'Saudi Riyal', '﷼', 2, false, ['32.400000', '32.660000']],
  ['AED', 'UAE Dirham', 'د.إ', 2, false, ['33.080000', '33.350000']],
];

const TAX_RATES = [
  // code, name, type, rate, description
  ['VAT15', 'VAT 15%', 'vat', '15.0000', 'Standard VAT rate'],
  ['VAT10', 'VAT 10%', 'vat', '10.0000', 'Reduced VAT rate'],
  ['VAT7.5', 'VAT 7.5%', 'vat', '7.5000', 'Reduced VAT rate (trading)'],
  ['VAT5', 'VAT 5%', 'vat', '5.0000', 'Reduced VAT rate'],
  ['VAT0', 'VAT Exempt', 'vat', '0.0000', 'Exempted goods and services'],
  ['SD10', 'Supplementary Duty 10%', 'sd', '10.0000', null],
  ['SD20', 'Supplementary Duty 20%', 'sd', '20.0000', null],
  ['SD30', 'Supplementary Duty 30%', 'sd', '30.0000', null],
  ['AIT5', 'Advance Income Tax 5%', 'ait', '5.0000', 'Deducted at source on purchases'],
];

const TAX_GROUPS = [
  // code, name, description, [[rateCode, compound]]
  ['STD', 'Standard VAT (15%)', 'Most goods and services', [['VAT15', false]]],
  ['TRD', 'Trading VAT (7.5%)', null, [['VAT7.5', false]]],
  ['RED5', 'Reduced VAT (5%)', null, [['VAT5', false]]],
  ['EXEMPT', 'VAT Exempt', null, [['VAT0', false]]],
  // VAT is charged on the SD-inclusive value.
  [
    'SD20VAT15',
    'SD 20% + VAT 15%',
    'Luxury and SD-able goods',
    [
      ['SD20', false],
      ['VAT15', true],
    ],
  ],
  [
    'SD10VAT15',
    'SD 10% + VAT 15%',
    null,
    [
      ['SD10', false],
      ['VAT15', true],
    ],
  ],
];

const SEQUENCES = [
  // docType, name, prefix (with tokens), padding, perBranch
  ['sales_invoice', 'Sales invoice', 'INV-{BRANCH}-{YYYY}-', 5, true],
  ['pos_sale', 'POS receipt', 'POS-{BRANCH}-{YY}{MM}-', 6, true],
  ['quotation', 'Quotation', 'QT-{YYYY}-', 5, false],
  ['sales_order', 'Sales order', 'SO-{YYYY}-', 5, false],
  ['delivery_note', 'Delivery note', 'DN-{BRANCH}-{YYYY}-', 5, true],
  ['sales_return', 'Sales return', 'SR-{YYYY}-', 5, false],
  ['money_receipt', 'Money receipt', 'MR-{BRANCH}-{YYYY}-', 5, true],
  ['purchase_order', 'Purchase order', 'PO-{YYYY}-', 5, false],
  ['purchase_bill', 'Purchase bill', 'BILL-{YYYY}-', 5, false],
  ['purchase_return', 'Purchase return', 'PR-{YYYY}-', 5, false],
  ['payment_voucher', 'Payment voucher', 'PV-{YYYY}-', 5, false],
  ['journal_entry', 'Journal entry', 'JV-{YYYY}-', 5, false],
  ['stock_transfer', 'Stock transfer', 'ST-{YYYY}-', 5, false],
  ['stock_adjustment', 'Stock adjustment', 'SA-{YYYY}-', 5, false],
  ['production_order', 'Production order', 'MO-{YYYY}-', 5, false],
];

const UNITS = [
  // code, name, category, allowDecimal
  ['pcs', 'Pieces', 'count', false],
  ['dozen', 'Dozen', 'count', false],
  ['box', 'Box', 'count', false],
  ['carton', 'Carton', 'count', false],
  ['pack', 'Pack', 'count', false],
  ['set', 'Set', 'count', false],
  ['kg', 'Kilogram', 'weight', true],
  ['g', 'Gram', 'weight', true],
  ['maund', 'Maund (মণ)', 'weight', true],
  ['ltr', 'Litre', 'volume', true],
  ['ml', 'Millilitre', 'volume', true],
  ['m', 'Metre', 'length', true],
  ['ft', 'Feet', 'length', true],
  ['yard', 'Yard', 'length', true],
  ['sqft', 'Square feet', 'area', true],
  ['hr', 'Hour', 'time', true],
];

const CONVERSIONS = [
  // 1 from = factor × to
  ['dozen', 'pcs', '12'],
  ['box', 'pcs', '12'],
  ['carton', 'box', '12'],
  ['kg', 'g', '1000'],
  ['maund', 'kg', '37.324'],
  ['ltr', 'ml', '1000'],
  ['m', 'ft', '3.28084'],
  ['yard', 'ft', '3'],
];

const PAYMENT_METHODS = [
  // code, name, type, provider, account, requiresReference
  ['CASH', 'Cash', 'cash', null, null, false],
  ['CARD', 'Card (Visa / Mastercard)', 'card', 'City Bank POS', null, true],
  ['BKASH', 'bKash', 'mobile_wallet', 'bKash', '01711-000111', true],
  ['NAGAD', 'Nagad', 'mobile_wallet', 'Nagad', '01811-000222', true],
  ['ROCKET', 'Rocket', 'mobile_wallet', 'Dutch-Bangla Bank', '01911-000333-4', true],
  ['BANK', 'Bank transfer', 'bank_transfer', 'BRAC Bank', '1501-2045-6789-001', true],
  ['CHEQUE', 'Cheque', 'cheque', null, null, true],
];

const TERMS = [
  'Goods once sold are not returnable after 7 days.',
  'Please check the goods at delivery; claims for damage are accepted within 24 hours.',
  'Payment is due within the agreed credit period. Cheques are payable to Holydeen Trading Ltd.',
].join('\n');

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    const [branches] = await db.query('SELECT id, code FROM branches WHERE company_id = ?', {
      replacements: [company.id],
    });
    const branchId = Object.fromEntries(branches.map((b) => [b.code, b.id]));
    const now = new Date();
    const base = { company_id: company.id, created_at: now, updated_at: now };
    const idsOf = async (table, key = 'code') => {
      const [rows] = await db.query(`SELECT id, \`${key}\` AS k FROM \`${table}\` WHERE company_id = ?`, {
        replacements: [company.id],
      });
      return Object.fromEntries(rows.map((r) => [r.k, r.id]));
    };

    await queryInterface.bulkUpdate(
      'companies',
      {
        tin_no: '456789123456',
        vat_reg_no: '004567891-0101',
        website: 'https://holydeen.com',
      },
      { id: company.id },
    );

    await queryInterface.bulkInsert('warehouses', [
      {
        ...base,
        branch_id: branchId.HO,
        code: 'WH-TEJ',
        name: 'Tejgaon Central Warehouse',
        phone: '+8801711000011',
        address: '215 Tejgaon I/A, Dhaka 1208',
        is_default: true,
        is_active: true,
      },
      {
        ...base,
        branch_id: branchId.HO,
        code: 'WH-MTJ',
        name: 'Motijheel Showroom Store',
        phone: '+8801711000012',
        address: '72 Motijheel C/A, Dhaka 1000',
        is_default: false,
        is_active: true,
      },
      {
        ...base,
        branch_id: branchId.CTG,
        code: 'WH-AGR',
        name: 'Agrabad Warehouse',
        phone: '+8801811000021',
        address: '1112 Sheikh Mujib Road, Agrabad, Chattogram',
        is_default: true,
        is_active: true,
      },
      {
        ...base,
        branch_id: branchId.SYL,
        code: 'WH-SYL',
        name: 'Zindabazar Store',
        phone: '+8801911000031',
        address: 'Zindabazar Main Road, Sylhet',
        is_default: true,
        is_active: true,
      },
    ]);

    await queryInterface.bulkInsert(
      'currencies',
      CURRENCIES.map(([code, name, symbol, decimals, isBase]) => ({
        ...base,
        code,
        name,
        symbol,
        decimal_places: decimals,
        is_base: isBase,
        is_active: true,
      })),
    );
    const currencyId = await idsOf('currencies');
    await queryInterface.bulkInsert(
      'exchange_rates',
      CURRENCIES.filter((c) => c[5]).flatMap(([code, , , , , [old, current]]) => [
        { ...base, currency_id: currencyId[code], rate: old, effective_date: daysAgo(30) },
        { ...base, currency_id: currencyId[code], rate: current, effective_date: today },
      ]),
    );

    await queryInterface.bulkInsert(
      'tax_rates',
      TAX_RATES.map(([code, name, type, rate, description]) => ({
        ...base,
        code,
        name,
        type,
        rate,
        description,
        is_active: true,
      })),
    );
    const taxRateId = await idsOf('tax_rates');
    await queryInterface.bulkInsert(
      'tax_groups',
      TAX_GROUPS.map(([code, name, description]) => ({ ...base, code, name, description, is_active: true })),
    );
    const taxGroupId = await idsOf('tax_groups');
    await queryInterface.bulkInsert(
      'tax_group_rates',
      TAX_GROUPS.flatMap(([code, , , rates]) =>
        rates.map(([rateCode, compound], i) => ({
          tax_group_id: taxGroupId[code],
          tax_rate_id: taxRateId[rateCode],
          sequence: i + 1,
          is_compound: compound,
          created_at: now,
        })),
      ),
    );

    const year = Number(
      new Intl.DateTimeFormat('en', { timeZone: 'Asia/Dhaka', year: 'numeric' }).format(now),
    );
    await queryInterface.bulkInsert(
      'document_sequences',
      SEQUENCES.flatMap(([docType, name, prefix, padding, perBranch]) =>
        (perBranch ? ['HO', 'CTG', 'SYL'] : [null]).map((code) => ({
          ...base,
          branch_id: code ? branchId[code] : null,
          doc_type: docType,
          name: code ? `${name} — ${code}` : name,
          prefix,
          suffix: '',
          padding,
          next_number: 1,
          reset_yearly: true,
          current_year: year,
          is_active: true,
        })),
      ),
    );

    await queryInterface.bulkInsert(
      'units',
      UNITS.map(([code, name, category, allowDecimal]) => ({
        ...base,
        code,
        name,
        category,
        allow_decimal: allowDecimal,
        is_active: true,
      })),
    );
    const unitId = await idsOf('units');
    await queryInterface.bulkInsert(
      'unit_conversions',
      CONVERSIONS.map(([from, to, factor]) => ({
        ...base,
        from_unit_id: unitId[from],
        to_unit_id: unitId[to],
        factor,
      })),
    );

    await queryInterface.bulkInsert(
      'payment_methods',
      PAYMENT_METHODS.map(([code, name, type, provider, account, requiresReference], i) => ({
        ...base,
        code,
        name,
        type,
        provider,
        account_number: account,
        requires_reference: requiresReference,
        sort_order: (i + 1) * 10,
        is_active: true,
      })),
    );

    await queryInterface.bulkInsert('print_templates', [
      {
        ...base,
        name: 'Tax invoice (A4)',
        doc_type: 'invoice',
        paper: 'a4',
        is_default: true,
        options: JSON.stringify({ title: 'Tax Invoice', accentColor: '#0f766e' }),
        terms: TERMS,
        footer_note: 'Thank you for your business!',
      },
      {
        ...base,
        name: 'POS receipt (80 mm)',
        doc_type: 'pos_receipt',
        paper: 'thermal_80',
        is_default: true,
        options: JSON.stringify({ title: 'Sales Receipt' }),
        terms: 'No refund without receipt. Exchange within 7 days.',
        footer_note: 'ধন্যবাদ, আবার আসবেন!',
      },
      {
        ...base,
        name: 'Quotation (A4)',
        doc_type: 'quotation',
        paper: 'a4',
        is_default: true,
        options: JSON.stringify({ title: 'Quotation', showMushakRef: false, showSignature: true }),
        terms: 'This quotation is valid for 15 days.',
        footer_note: null,
      },
      {
        ...base,
        name: 'Money receipt (A4)',
        doc_type: 'money_receipt',
        paper: 'a4',
        is_default: true,
        options: JSON.stringify({ title: 'Money Receipt', showTaxBreakdown: false, showMushakRef: false }),
        terms: null,
        footer_note: null,
      },
    ]);
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query('SELECT id FROM companies WHERE code = ?', {
      replacements: [COMPANY],
    });
    if (!company) return;
    const where = { company_id: company.id };
    await db.query(
      'DELETE tgr FROM tax_group_rates tgr JOIN tax_groups tg ON tg.id = tgr.tax_group_id WHERE tg.company_id = ?',
      { replacements: [company.id] },
    );
    for (const table of [
      'print_templates',
      'payment_methods',
      'unit_conversions',
      'units',
      'document_sequences',
      'tax_groups',
      'tax_rates',
      'exchange_rates',
      'currencies',
      'warehouses',
    ]) {
      await queryInterface.bulkDelete(table, where);
    }
  },
};
