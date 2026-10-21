'use strict';

/**
 * Master data demo for Holydeen Trading Ltd.: category tree, brands, attributes, products
 * (with packs and a variant product), customer/supplier groups, customers and suppliers.
 */

const ean13 = (first12) => {
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return first12 + ((10 - (sum % 10)) % 10);
};

const CATEGORIES = [
  // code, name, parent, sort
  ['GROCERY', 'Grocery', null, 1],
  ['RICE', 'Rice', 'GROCERY', 1],
  ['OIL', 'Edible Oil', 'GROCERY', 2],
  ['FLOUR', 'Flour & Atta', 'GROCERY', 3],
  ['SUGAR', 'Sugar & Salt', 'GROCERY', 4],
  ['PULSES', 'Pulses (Dal)', 'GROCERY', 5],
  ['SPICES', 'Spices', 'GROCERY', 6],
  ['BEVERAGE', 'Tea & Beverages', 'GROCERY', 7],
  ['SNACKS', 'Biscuits & Snacks', 'GROCERY', 8],
  ['PERSONAL', 'Personal Care', null, 2],
  ['SOAP', 'Soap & Body Wash', 'PERSONAL', 1],
  ['SKINCARE', 'Skin Care', 'PERSONAL', 2],
  ['HOUSEHOLD', 'Household', null, 3],
  ['DETERGENT', 'Detergent & Cleaning', 'HOUSEHOLD', 1],
  ['ELECTRONICS', 'Electronics', null, 4],
  ['ACCESSORIES', 'Mobile & Electrical Accessories', 'ELECTRONICS', 1],
  ['APPAREL', 'Apparel', null, 5],
  ['RAWMAT', 'Raw Materials', null, 6],
  ['PACKAGING', 'Packaging', 'RAWMAT', 1],
  ['OFFICE', 'Office Supplies', null, 7],
  ['SERVICES', 'Services', null, 8],
];

const BRANDS = [
  ['ACI', 'ACI', 'ACI Limited'],
  ['PRAN', 'PRAN', 'PRAN-RFL Group'],
  ['TEER', 'Teer', 'City Group'],
  ['RUPCHANDA', 'Rupchanda', 'Bangladesh Edible Oil Ltd.'],
  ['FRESH', 'Fresh', 'Meghna Group of Industries'],
  ['ISPAHANI', 'Ispahani', 'M. M. Ispahani Ltd.'],
  ['OLYMPIC', 'Olympic', 'Olympic Industries Ltd.'],
  ['UNILEVER', 'Unilever', 'Unilever Bangladesh Ltd.'],
  ['SQUARE', 'Square', 'Square Toiletries Ltd.'],
  ['WALTON', 'Walton', 'Walton Hi-Tech Industries'],
  ['EASY', 'Easy', 'Easy Fashion Ltd.'],
];

const ATTRIBUTES = [
  ['Size', 1, ['S', 'M', 'L', 'XL']],
  ['Color', 2, ['Navy', 'White', 'Black', 'Red']],
];

// name, category, brand, unit, purchase, sale, taxGroup, type, flags, barcode, extra units [unit, factor, salePrice]
const PRODUCTS = [
  [
    'ACI Pure Miniket Rice 5 kg',
    'RICE',
    'ACI',
    'pcs',
    '365',
    '410',
    'EXEMPT',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000001'),
    [['carton', '4', '1620']],
  ],
  [
    'PRAN Chinigura Aromatic Rice 1 kg',
    'RICE',
    'PRAN',
    'pcs',
    '135',
    '155',
    'EXEMPT',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000002'),
    [],
  ],
  [
    'Teer Soybean Oil 5 L',
    'OIL',
    'TEER',
    'pcs',
    '820',
    '870',
    'TRD',
    'finished_good',
    { trackBatch: true, trackExpiry: true },
    ean13('200000000003'),
    [['carton', '4', '3440']],
  ],
  [
    'Rupchanda Soybean Oil 1 L',
    'OIL',
    'RUPCHANDA',
    'pcs',
    '168',
    '180',
    'TRD',
    'finished_good',
    { trackBatch: true, trackExpiry: true },
    ean13('200000000004'),
    [['carton', '12', '2130']],
  ],
  [
    'Fresh Atta 2 kg',
    'FLOUR',
    'FRESH',
    'pcs',
    '120',
    '135',
    'EXEMPT',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000005'),
    [],
  ],
  [
    'Fresh Refined Sugar 1 kg',
    'SUGAR',
    'FRESH',
    'pcs',
    '125',
    '140',
    'EXEMPT',
    'finished_good',
    {},
    ean13('200000000006'),
    [],
  ],
  [
    'Red Lentil (Masoor Dal) — loose',
    'PULSES',
    null,
    'kg',
    '105',
    '120',
    'EXEMPT',
    'finished_good',
    {},
    null,
    [],
  ],
  [
    'Ispahani Mirzapore Best Leaf Tea 400 g',
    'BEVERAGE',
    'ISPAHANI',
    'pcs',
    '230',
    '255',
    'STD',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000008'),
    [['carton', '24', '6000']],
  ],
  [
    'Olympic Energy Plus Biscuit',
    'SNACKS',
    'OLYMPIC',
    'pcs',
    '18',
    '20',
    'STD',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000009'),
    [
      ['box', '12', '235'],
      ['carton', '144', '2760'],
    ],
  ],
  [
    'PRAN Frooto Mango Juice 250 ml',
    'BEVERAGE',
    'PRAN',
    'pcs',
    '22',
    '25',
    'SD10VAT15',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000010'),
    [['carton', '24', '580']],
  ],
  [
    'Lux Soft Touch Soap 100 g',
    'SOAP',
    'UNILEVER',
    'pcs',
    '52',
    '60',
    'STD',
    'finished_good',
    {},
    ean13('200000000011'),
    [['dozen', '12', '700']],
  ],
  [
    'Wheel Washing Powder 1 kg',
    'DETERGENT',
    'UNILEVER',
    'pcs',
    '110',
    '125',
    'STD',
    'finished_good',
    {},
    ean13('200000000012'),
    [],
  ],
  [
    'Meril Petroleum Jelly 100 ml',
    'SKINCARE',
    'SQUARE',
    'pcs',
    '75',
    '85',
    'STD',
    'finished_good',
    { trackExpiry: true },
    ean13('200000000013'),
    [],
  ],
  [
    'Walton Power Bank 10000 mAh',
    'ACCESSORIES',
    'WALTON',
    'pcs',
    '1150',
    '1450',
    'STD',
    'finished_good',
    { trackSerial: true },
    ean13('200000000014'),
    [],
  ],
  [
    'Walton LED Bulb 12 W',
    'ACCESSORIES',
    'WALTON',
    'pcs',
    '160',
    '210',
    'STD',
    'finished_good',
    {},
    ean13('200000000015'),
    [['box', '10', '2000']],
  ],
  [
    'Holydeen Garam Masala 200 g',
    'SPICES',
    null,
    'pcs',
    '60',
    '95',
    'STD',
    'finished_good',
    { trackBatch: true, trackExpiry: true },
    ean13('200000000016'),
    [],
  ],
  [
    'PET Bottle 1 L (clear)',
    'PACKAGING',
    null,
    'pcs',
    '6.50',
    '0',
    'STD',
    'raw_material',
    {},
    null,
    [['carton', '200', null]],
  ],
  ['5-Ply Carton Box 18×12×10 in', 'PACKAGING', null, 'pcs', '28', '0', 'STD', 'raw_material', {}, null, []],
  [
    'A4 Copy Paper 80 gsm (500 sheets)',
    'OFFICE',
    null,
    'pack',
    '430',
    '0',
    'STD',
    'consumable',
    {},
    null,
    [],
  ],
  ['Home Delivery — inside Dhaka', 'SERVICES', null, 'pcs', '0', '80', 'EXEMPT', 'service', {}, null, []],
];

const VARIANT_PRODUCT = ['Easy Polo T-Shirt (cotton pique)', 'APPAREL', 'EASY', 'pcs', '450', '850', 'STD'];
const VARIANTS = [
  [['M', 'Navy'], '850'],
  [['L', 'Navy'], '850'],
  [['M', 'White'], '850'],
  [['L', 'White'], '890'],
];

const GROUPS = [
  ['customer', 'RETAIL', 'Retail', 'Walk-in and small shops'],
  ['customer', 'WHOLESALE', 'Wholesale', 'Bulk buyers with credit'],
  ['customer', 'CORPORATE', 'Corporate', 'Companies on monthly billing'],
  ['supplier', 'LOCAL', 'Local manufacturers', null],
  ['supplier', 'IMPORTER', 'Importers / foreign', null],
];

// name, contact, phone, email, group, credit, terms, opening, address [line, city, district, postal], extra
const CUSTOMERS = [
  ['Walk-in Customer', null, null, null, 'RETAIL', '0', 0, '0', null, {}],
  [
    'Karim Traders',
    'Abdul Karim',
    '+8801711445566',
    'karimtraders@gmail.com',
    'WHOLESALE',
    '300000',
    15,
    '42500',
    ['Shop 14, Kawran Bazar', 'Dhaka', 'Dhaka', '1215'],
    { binNo: '001234567-0201' },
  ],
  [
    'Rahim General Store',
    'Md. Rahim Uddin',
    '+8801819223344',
    null,
    'RETAIL',
    '50000',
    7,
    '0',
    ['Section 10, Block C, Mirpur', 'Dhaka', 'Dhaka', '1216'],
    {},
  ],
  [
    'Bismillah Enterprise',
    'Nurul Islam',
    '+8801911667788',
    'bismillah.ctg@yahoo.com',
    'WHOLESALE',
    '500000',
    30,
    '118000',
    ['Chawkbazar Main Road', 'Chattogram', 'Chattogram', '4203'],
    { binNo: '002345678-0102', alsoSupplier: true },
  ],
  [
    'Shapla Super Shop',
    'Jahid Hasan',
    '+8801712345678',
    'shapla.supershop@gmail.com',
    'RETAIL',
    '80000',
    15,
    '0',
    ['House 12, Road 5, Dhanmondi', 'Dhaka', 'Dhaka', '1205'],
    {},
  ],
  [
    'Green Valley Garments Ltd.',
    'HR & Admin',
    '+8809612778899',
    'admin@greenvalley-bd.com',
    'CORPORATE',
    '1000000',
    30,
    '0',
    ['Plot 45, BSCIC Industrial Area, Konabari', 'Gazipur', 'Gazipur', '1700'],
    { binNo: '003456789-0301', tinNo: '512345678901' },
  ],
  [
    'Surma Valley Tea Estates Ltd.',
    'Procurement',
    '+8801977001122',
    'purchase@surmatea.com',
    'CORPORATE',
    '600000',
    45,
    '25500',
    ['Lakkatura, Airport Road', 'Sylhet', 'Sylhet', '3100'],
    { binNo: '004567890-0501' },
  ],
  [
    'Mayer Doa Store',
    'Selina Akter',
    '+8801556112233',
    null,
    'RETAIL',
    '20000',
    7,
    '0',
    ['Kazir Dewri, Station Road', 'Chattogram', 'Chattogram', '4000'],
    {},
  ],
];

const SUPPLIERS = [
  [
    'ACI Limited',
    'Distributor desk',
    '+8809666777888',
    'sales@aci-bd.com',
    'LOCAL',
    '0',
    30,
    '0',
    ['245 Tejgaon Industrial Area', 'Dhaka', 'Dhaka', '1208'],
    { binNo: '000123456-0101' },
  ],
  [
    'PRAN-RFL Group',
    'Dealer support',
    '+8809612000111',
    'dealer@prangroup.com',
    'LOCAL',
    '0',
    21,
    '85000',
    ['PRAN-RFL Center, 105 Middle Badda', 'Dhaka', 'Dhaka', '1212'],
    { binNo: '000234567-0101' },
  ],
  [
    'City Group (Teer)',
    'Sales office',
    '+8801730000222',
    null,
    'LOCAL',
    '0',
    15,
    '0',
    ['Rupganj', 'Narayanganj', 'Narayanganj', '1460'],
    {},
  ],
  [
    'Meghna Group of Industries (Fresh)',
    'Sales office',
    '+8809612000333',
    null,
    'LOCAL',
    '0',
    30,
    '0',
    ['Meghna Ghat, Sonargaon', 'Narayanganj', 'Narayanganj', '1441'],
    {},
  ],
  [
    'Unilever Bangladesh Ltd.',
    'Customer care',
    '+8809612000444',
    null,
    'LOCAL',
    '0',
    30,
    '0',
    ['Kalurghat Heavy Industrial Area', 'Chattogram', 'Chattogram', '4208'],
    { binNo: '000345678-0201' },
  ],
  [
    'Walton Hi-Tech Industries Ltd.',
    'Corporate sales',
    '+8809612316267',
    null,
    'LOCAL',
    '0',
    30,
    '0',
    ['Chandra, Kaliakair', 'Gazipur', 'Gazipur', '1750'],
    {},
  ],
  [
    'Guangzhou Huasheng Packaging Co.',
    'Ms. Lin',
    '+862088880000',
    'export@hspack.cn',
    'IMPORTER',
    '0',
    60,
    '0',
    ['Baiyun District', 'Guangzhou', null, '510000'],
    { country: 'China' },
  ],
];

module.exports = {
  async up(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query("SELECT id FROM companies WHERE code = 'HOLYDEEN'");
    const companyId = company.id;
    const now = new Date();
    const base = { company_id: companyId, created_at: now, updated_at: now };
    const map = async (sql) => {
      const [rows] = await db.query(sql, { replacements: [companyId] });
      return Object.fromEntries(rows.map((r) => [r.k, r.id]));
    };

    // Number series for generated codes.
    await queryInterface.bulkInsert('document_sequences', [
      {
        ...base,
        branch_id: null,
        doc_type: 'product_sku',
        name: 'Product SKU',
        prefix: 'P-',
        suffix: '',
        padding: 6,
        next_number: PRODUCTS.length + 2,
        reset_yearly: false,
        current_year: null,
        is_active: true,
      },
      {
        ...base,
        branch_id: null,
        doc_type: 'customer_code',
        name: 'Customer code',
        prefix: 'CUS-',
        suffix: '',
        padding: 5,
        next_number: CUSTOMERS.length + 1,
        reset_yearly: false,
        current_year: null,
        is_active: true,
      },
      {
        ...base,
        branch_id: null,
        doc_type: 'supplier_code',
        name: 'Supplier code',
        prefix: 'SUP-',
        suffix: '',
        padding: 5,
        next_number: SUPPLIERS.length + 1,
        reset_yearly: false,
        current_year: null,
        is_active: true,
      },
    ]);

    // Categories: parents first.
    for (const [code, name, parent, sort] of CATEGORIES) {
      const parentId = parent
        ? (await map('SELECT id, code AS k FROM product_categories WHERE company_id = ?'))[parent]
        : null;
      await queryInterface.bulkInsert('product_categories', [
        { ...base, code, name, parent_id: parentId, sort_order: sort, is_active: true },
      ]);
    }
    const categories = await map('SELECT id, code AS k FROM product_categories WHERE company_id = ?');

    await queryInterface.bulkInsert(
      'brands',
      BRANDS.map(([code, name, description]) => ({ ...base, code, name, description, is_active: true })),
    );
    const brands = await map('SELECT id, code AS k FROM brands WHERE company_id = ?');

    await queryInterface.bulkInsert(
      'product_attributes',
      ATTRIBUTES.map(([name, sort]) => ({ ...base, name, sort_order: sort })),
    );
    const attributes = await map('SELECT id, name AS k FROM product_attributes WHERE company_id = ?');
    await queryInterface.bulkInsert(
      'product_attribute_values',
      ATTRIBUTES.flatMap(([name, , values]) =>
        values.map((value, i) => ({
          attribute_id: attributes[name],
          value,
          sort_order: i,
          created_at: now,
          updated_at: now,
        })),
      ),
    );
    const [valueRows] = await db.query(
      'SELECT v.id, v.value FROM product_attribute_values v JOIN product_attributes a ON a.id = v.attribute_id WHERE a.company_id = ?',
      { replacements: [companyId] },
    );
    const valueId = Object.fromEntries(valueRows.map((r) => [r.value, r.id]));

    const units = await map('SELECT id, code AS k FROM units WHERE company_id = ?');
    const taxGroups = await map('SELECT id, code AS k FROM tax_groups WHERE company_id = ?');
    const sku = (n) => `P-${String(n).padStart(6, '0')}`;

    await queryInterface.bulkInsert(
      'products',
      PRODUCTS.map(([name, category, brand, unit, purchase, sale, tax, type, flags, barcode], i) => ({
        ...base,
        sku: sku(i + 1),
        name,
        type,
        barcode,
        barcode_type: barcode ? 'EAN13' : 'CODE128',
        category_id: categories[category],
        brand_id: brand ? brands[brand] : null,
        base_unit_id: units[unit],
        purchase_price: purchase,
        sale_price: sale,
        tax_group_id: taxGroups[tax],
        price_includes_tax: false,
        reorder_level: type === 'service' ? '0' : unit === 'kg' ? '50' : '20',
        track_batch: Boolean(flags.trackBatch),
        track_serial: Boolean(flags.trackSerial),
        track_expiry: Boolean(flags.trackExpiry),
        has_variants: false,
        is_active: true,
      })),
    );
    const products = await map('SELECT id, sku AS k FROM products WHERE company_id = ?');
    await queryInterface.bulkInsert(
      'product_units',
      PRODUCTS.flatMap((p, i) =>
        p[10].map(([unit, factor, salePrice], j) => ({
          product_id: products[sku(i + 1)],
          unit_id: units[unit],
          factor,
          barcode: null,
          purchase_price: null,
          sale_price: salePrice,
          is_default_purchase: j === p[10].length - 1,
          is_default_sale: false,
          created_at: now,
          updated_at: now,
        })),
      ),
    );

    // Variant product: Easy Polo T-shirt in sizes × colours.
    const [name, category, brand, unit, purchase, sale, tax] = VARIANT_PRODUCT;
    const polo = sku(PRODUCTS.length + 1);
    await queryInterface.bulkInsert('products', [
      {
        ...base,
        sku: polo,
        name,
        type: 'finished_good',
        barcode: null,
        barcode_type: 'CODE128',
        category_id: categories[category],
        brand_id: brands[brand],
        base_unit_id: units[unit],
        purchase_price: purchase,
        sale_price: sale,
        tax_group_id: taxGroups[tax],
        price_includes_tax: true,
        reorder_level: '10',
        track_batch: false,
        track_serial: false,
        track_expiry: false,
        has_variants: true,
        is_active: true,
      },
    ]);
    const poloId = (await map('SELECT id, sku AS k FROM products WHERE company_id = ?'))[polo];
    await queryInterface.bulkInsert(
      'product_variants',
      VARIANTS.map(([values, price], i) => ({
        ...base,
        product_id: poloId,
        sku: `${polo}-${values.map((v) => v.toUpperCase()).join('-')}`,
        barcode: ean13(`2000000001${String(i + 1).padStart(2, '0')}`),
        name: values.join(' / '),
        purchase_price: null,
        sale_price: price,
        is_active: true,
      })),
    );
    const variants = await map(`SELECT id, sku AS k FROM product_variants WHERE company_id = ?`);
    await queryInterface.bulkInsert(
      'product_variant_values',
      VARIANTS.flatMap(([values]) => {
        const variantId = variants[`${polo}-${values.map((v) => v.toUpperCase()).join('-')}`];
        return values.map((v) => ({ variant_id: variantId, attribute_value_id: valueId[v] }));
      }),
    );

    // Parties
    await queryInterface.bulkInsert(
      'party_groups',
      GROUPS.map(([type, code, name, description]) => ({
        ...base,
        type,
        code,
        name,
        description,
        is_active: true,
      })),
    );
    const [groupRows] = await db.query('SELECT id, type, code FROM party_groups WHERE company_id = ?', {
      replacements: [companyId],
    });
    const groupId = (type, code) => groupRows.find((g) => g.type === type && g.code === code)?.id ?? null;

    const partyRow = (role, list) =>
      list.map(([pname, contact, phone, email, group, credit, terms, opening, , extra], i) => ({
        ...base,
        code: `${role === 'customer' ? 'CUS' : 'SUP'}-${String(i + 1).padStart(5, '0')}`,
        name: pname,
        contact_person: contact,
        phone,
        email,
        bin_no: extra.binNo ?? null,
        tin_no: extra.tinNo ?? null,
        is_customer: role === 'customer',
        is_supplier: role === 'supplier' || Boolean(extra.alsoSupplier),
        customer_group_id: role === 'customer' ? groupId('customer', group) : null,
        supplier_group_id:
          role === 'supplier'
            ? groupId('supplier', group)
            : extra.alsoSupplier
              ? groupId('supplier', 'LOCAL')
              : null,
        credit_limit: credit,
        payment_terms_days: terms,
        opening_balance: opening,
        opening_balance_type: role === 'customer' ? 'debit' : 'credit',
        is_active: true,
      }));
    await queryInterface.bulkInsert('parties', [
      ...partyRow('customer', CUSTOMERS),
      ...partyRow('supplier', SUPPLIERS),
    ]);
    const parties = await map('SELECT id, code AS k FROM parties WHERE company_id = ?');

    const addresses = [
      ...CUSTOMERS.map((c, i) => [`CUS-${String(i + 1).padStart(5, '0')}`, c]),
      ...SUPPLIERS.map((s, i) => [`SUP-${String(i + 1).padStart(5, '0')}`, s]),
    ]
      .filter(([, p]) => p[8])
      .map(([code, p]) => ({
        party_id: parties[code],
        type: 'billing',
        label: 'Office',
        address_line: p[8][0],
        city: p[8][1],
        district: p[8][2],
        postal_code: p[8][3],
        country: p[9].country ?? 'Bangladesh',
        phone: p[2],
        is_default: true,
        created_at: now,
        updated_at: now,
      }));
    // A second (shipping) address for the wholesale customer.
    addresses.push({
      party_id: parties['CUS-00002'],
      type: 'shipping',
      label: 'Godown',
      address_line: 'Godown 3, Tejgaon Rail Gate',
      city: 'Dhaka',
      district: 'Dhaka',
      postal_code: '1208',
      country: 'Bangladesh',
      phone: '+8801711445567',
      is_default: false,
      created_at: now,
      updated_at: now,
    });
    await queryInterface.bulkInsert('party_addresses', addresses);
  },

  async down(queryInterface) {
    const db = queryInterface.sequelize;
    const [[company]] = await db.query("SELECT id FROM companies WHERE code = 'HOLYDEEN'");
    if (!company) return;
    const c = [company.id];
    await db.query(
      'DELETE pa FROM party_addresses pa JOIN parties p ON p.id = pa.party_id WHERE p.company_id = ?',
      { replacements: c },
    );
    await queryInterface.bulkDelete('parties', { company_id: company.id });
    await queryInterface.bulkDelete('party_groups', { company_id: company.id });
    await db.query(
      'DELETE vv FROM product_variant_values vv JOIN product_variants v ON v.id = vv.variant_id WHERE v.company_id = ?',
      { replacements: c },
    );
    await queryInterface.bulkDelete('product_variants', { company_id: company.id });
    await db.query(
      'DELETE pu FROM product_units pu JOIN products p ON p.id = pu.product_id WHERE p.company_id = ?',
      { replacements: c },
    );
    await queryInterface.bulkDelete('products', { company_id: company.id });
    await db.query(
      'DELETE v FROM product_attribute_values v JOIN product_attributes a ON a.id = v.attribute_id WHERE a.company_id = ?',
      { replacements: c },
    );
    await queryInterface.bulkDelete('product_attributes', { company_id: company.id });
    await queryInterface.bulkDelete('brands', { company_id: company.id });
    await db.query('UPDATE product_categories SET parent_id = NULL WHERE company_id = ?', {
      replacements: c,
    });
    await queryInterface.bulkDelete('product_categories', { company_id: company.id });
    await queryInterface.bulkDelete('document_sequences', {
      company_id: company.id,
      doc_type: ['product_sku', 'customer_code', 'supplier_code'],
    });
  },
};
