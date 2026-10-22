# Holydeen ERP — Backend

REST API for Holydeen ERP: **Node.js 20 + Express 5 + Sequelize + MySQL 8** (ES modules).
The web app lives in the separate `holydeen-erp-client` project. Project rules: see `CLAUDE.md` in this repo.

## Prerequisites

- Node.js 20+ (`.nvmrc`)
- MySQL 8 — via Docker (`docker-compose.yml` in this folder) or a local install
- Windows: if a native module fails with _"The specified module could not be found"_, install the
  [Microsoft Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe).

## Setup

```bash
npm install
cp .env.example .env            # then set the JWT secrets (generator command is in the file)

npm run db:up                   # MySQL in Docker; credentials match .env.example
#   …or use your own MySQL 8: edit DB_* in .env, then `npm run db:create`

npm run db:migrate
npm run db:seed
npm run dev                     # http://localhost:5000
```

| URL                                       | What                                                               |
| ----------------------------------------- | ------------------------------------------------------------------ |
| http://localhost:5000/api/v1/health       | Liveness check                                                     |
| http://localhost:5000/api/v1/health/ready | Readiness check incl. database (`503` when MySQL is down)          |
| http://localhost:5000/api/docs            | Swagger UI                                                         |
| http://localhost:8080                     | Adminer — `docker compose --profile tools up -d` (server: `mysql`) |

## Scripts

| Command                                                        | Description                            |
| -------------------------------------------------------------- | -------------------------------------- |
| `npm run dev` / `npm start`                                    | Run with nodemon / plain node          |
| `npm test`                                                     | Jest + Supertest                       |
| `npm run lint` · `lint:fix` · `format`                         | ESLint / Prettier                      |
| `npm run db:up` · `db:down`                                    | Start / stop the MySQL container       |
| `npm run db:create`                                            | Create the database (non-Docker MySQL) |
| `npm run db:migrate` · `db:migrate:undo` · `db:migrate:status` | Migrations                             |
| `npm run db:seed` · `db:seed:undo`                             | Seeders                                |
| `npm run migration:new -- create-customers`                    | New migration in `src/migrations`      |
| `npm run seed:new -- demo-customers`                           | New seeder in `src/seeders`            |
| `npm run accounting:backfill`                                  | Post journals missing for old documents |

## Demo accounts (after `npm run db:seed`)

Company **Holydeen Trading Ltd.** with branches Dhaka Head Office (HO), Chattogram (CTG) and Sylhet (SYL).
Every demo account uses the password **`Password@123`** (development only — change before going live).

| Email                         | Role               | Branches                            |
| ----------------------------- | ------------------ | ----------------------------------- |
| `superadmin@holydeen.com`     | Super Admin        | all                                 |
| `admin@holydeen.com`          | Admin              | HO, CTG, SYL                        |
| `manager@holydeen.com`        | Manager            | HO, CTG                             |
| `accountant@holydeen.com`     | Accountant         | HO                                  |
| `storekeeper@holydeen.com`    | Store Keeper       | HO                                  |
| `cashier@holydeen.com`        | Cashier            | CTG                                 |
| `production@holydeen.com`     | Production Manager | HO                                  |
| `cashier.sylhet@holydeen.com` | Cashier            | SYL                                 |
| `rakib.hasan@holydeen.com`    | Store Keeper       | CTG (inactive — sign-in is refused) |

## Authentication & access control

- **Login** `POST /api/v1/auth/login` → access token (15 min, send as `Authorization: Bearer …`) plus an
  httpOnly refresh cookie `hd_rt` (7 days, path `/api/v1/auth`). `POST /auth/refresh` rotates it; replaying an
  old refresh token revokes that whole session.
- **Lockout**: 5 wrong passwords or 2FA codes → account locked for 15 minutes (HTTP 423). Activating the user
  (`PATCH /users/:id/status`) clears the lock. Every attempt is stored in `login_history`.
- **2FA** (TOTP): `POST /auth/2fa/setup` returns a QR code; confirm with `POST /auth/2fa/enable`.
- **Password reset**: `POST /auth/forgot-password` emails a 30-minute link to `APP_URL/reset-password/<token>`.
  Without `SMTP_HOST` the email is printed to the server log instead of being sent.
- **Permissions** are `<module>.<action>` (14 modules × 7 actions = 98), defined in
  `src/modules/roles/permission.catalog.cjs`. Protect a route with
  `router.post('/', authenticate, authorize('sales.create'), …)`; add `branchScope` to read the
  `X-Branch-Id` header into `req.branchId` / `req.branchIds`.

## Settings (`/api/v1/settings/...`)

Company profile and logo, branches, warehouses, currencies + dated exchange rates, tax rates and tax groups
(compound VAT on SD), document number series, units + conversions, payment methods, preferences
(`financial` / `system` / `smtp`), print templates (A4 / 80 mm) and database backups. Reads need
`settings.view`, writes `settings.create|update|delete`; backups are Super Admin only. All routes are in
Swagger under the "Settings · …" tags.

Demo data (`npm run db:seed`): 4 warehouses, BDT base + 7 currencies with rates, VAT 15/10/7.5/5/0 %,
SD 10/20/30 %, AIT 5 %, groups such as "SD 20% + VAT 15%", number series per branch
(`INV-{BRANCH}-{YYYY}-00001` …), 16 units with conversions (1 box = 12 pcs, 1 maund = 37.324 kg),
cash / card / bKash / Nagad / Rocket / bank / cheque, and invoice / POS receipt / quotation templates.

**Backups**: `POST /settings/backups` writes a gzipped SQL dump (schema + data, no `mysqldump` needed) to
`BACKUP_DIR`. Automatic backups run from `server.js` with node-cron (Asia/Dhaka time) once enabled in
Settings → Backups. On Hostinger set `BACKUP_DIR` to a folder **outside** the deployed app (it is rebuilt on
every deploy) and keep the Node app running for the schedule to fire.

**Running on Hostinger**

- `NODE_ENV=production`. The API listens immediately; if the database is unreachable it retries with backoff
  (30 s → 5 min) instead of exiting, and answers `503` (except `/api/v1/health/*`) until it connects.
- Scheduled jobs (backups, recurring invoices, payment reminders) take a MySQL named lock
  (`src/utils/jobLock.js`), so a second process — the old one during a deploy — skips the tick instead of
  duplicating invoices or emails.
- Swagger (`/api/docs`) is off in production unless `API_DOCS_ENABLED=true`.
- Keep `UPLOAD_DIR` and `BACKUP_DIR` outside the deployed folder; keep `LOG_LEVEL=info` (debug logs every SQL
  query when `DB_LOGGING=true`).

## Master data

| Resource                                    | Endpoint                                        | Permission   |
| ------------------------------------------- | ----------------------------------------------- | ------------ |
| Products (units/packs, variants, images)    | `/api/v1/products`                              | `products.*` |
| Category tree (drag & drop `POST /move`)    | `/api/v1/product-categories` (+ `/tree`)        | `products.*` |
| Brands (+ logo) · Attributes (Size, Color…) | `/api/v1/brands` · `/api/v1/product-attributes` | `products.*` |
| Customers · customer groups                 | `/api/v1/customers` · `/api/v1/customer-groups` | `sales.*`    |
| Suppliers · supplier groups                 | `/api/v1/suppliers` · `/api/v1/supplier-groups` | `purchase.*` |

- Customers and suppliers share the `parties` table; one party can be both (`alsoOtherRole`). Deleting it
  from one list only removes that role.
- Blank SKU / customer / supplier codes come from the `product_sku` (`P-000001`), `customer_code`
  (`CUS-00001`) and `supplier_code` (`SUP-00001`) number series.
- Barcodes: EAN-13 (check digit validated) or Code 128. `GET /products/barcode/generate` suggests a free in-store
  EAN-13 (`2…` prefix). Barcodes are unique across products, variants and packs, and product search also finds
  a product by a variant's or pack's barcode.
- `GET /products/lookups` returns units and tax groups for the product form (`products.view`), so users without
  settings access can still create products. `GET /products/labels?ids=1,2` returns label print data.
- **Excel import/export** on products, categories, brands, customers and suppliers:
  `GET …/import/template`, `POST …/import?mode=validate|report|commit[&skipInvalid=true]` (multipart `file`,
  .xlsx, ≤ 5,000 rows) and `GET …/export`. `validate` is a dry run with per-row errors, `report` returns the
  workbook with an Errors column, `commit` upserts by SKU / code. Exports use the template's columns, so they
  can be edited and re-imported.

Demo data: 21 categories (Grocery › Rice / Edible Oil / …), 11 brands (ACI, PRAN, Teer, Rupchanda, Fresh, …),
21 products incl. cartons/boxes and an Easy polo T-shirt with 4 size × colour variants, 8 customers, 7 suppliers
(one party is both) with addresses and groups.

## Inventory (`/api/v1/inventory/...`)

Stock is driven by an **append-only ledger** (`stock_movements`): every in/out records the warehouse, product,
variant, batch, signed base-unit quantity, unit cost, the source document (`reference_type` / `reference_id` /
`reference_no`) and the item's running quantity and value. Corrections are new, opposite movements — the model
refuses updates and deletes.

- **Derived state**, written in the same transaction as the movement: `stock_balances` (quantity, value and average
  cost per warehouse item, for fast lookups) and `stock_layers` (open receipts: FIFO cost layers that also hold batch
  quantities). `src/modules/inventory/stock.engine.js` is the only code that writes them; it locks each touched
  balance row (`SELECT … FOR UPDATE`, in a fixed order) before reading or writing that item, so concurrent postings
  can't oversell or deadlock.
- **Costing** (Settings → Inventory): weighted average or FIFO. Layers are kept under both, so the method can be
  switched at any time. An issue that empties an item takes exactly its remaining value.
- **Negative stock** is refused unless enabled in Settings → Inventory; batch- and serial-tracked items never go
  negative.
- **Batches & expiry**: products with `trackBatch` or `trackExpiry` hold stock per batch (`stock_batches`); stock-outs
  name the batch. **Serials**: `stock_serials` tracks each unit's warehouse and status
  (`in_stock`, `in_transit`, `issued`, `damaged`, `scrapped`, `written_off`).

| Document                                                        | Endpoint                 | Workflow                                                                   |
| --------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| Adjustment (`kind`: `adjustment`, `opening`, `damage`, `scrap`) | `/inventory/adjustments` | draft → submit → pending_approval → approve (posted) / reject → edit again |
| Transfer (any warehouse, across branches)                       | `/inventory/transfers`   | draft → dispatch (in transit) → receive; cancel returns dispatched stock   |
| Stock count (count sheet → variance → posting)                  | `/inventory/counts`      | counting → submit → pending_approval → approve (posted)                    |

With "Require approval" off, submit posts straight away. Opening stock is only accepted before any other movement of
the item in that warehouse. Permissions: `inventory.view` (stock, ledger, reports), `create` (drafts, submit),
`update` (edit drafts, counts, dispatch/receive), `approve` (approve/reject, cancel a dispatched transfer),
`delete` (drafts). Products and warehouses with stock history can no longer be deleted — deactivate them instead.

Read side: `GET /inventory/stock` (overview; `warehouseId`, `status=in_stock|low|out|negative`, …),
`/stock/summary`, `/products/:id` (per warehouse, batches, serials), `/products/:id/card` (stock card with running
balance), `/movements` (ledger), `/batches`, `/serials`, `/items/search` (name/SKU/barcode, `exact=true` for
scanners), `/alerts` (low/out of stock, near-expiry, expired, pending approvals, incoming transfers) and
`/reports/valuation|slow-moving|abc|expiry`.

Demo data (`20261022000001-inventory-demo`): number series `OS-` and `SC-`, and posted opening stock in the Tejgaon
warehouse with a batch expiring soon and two items below their reorder level. On an existing database run
`npm run db:migrate` and then only that seeder:
`npx sequelize-cli db:seed --seed 20261022000001-inventory-demo.js`.

## Purchase (`/api/v1/purchase/...`)

Requisition → RFQ (optional) → purchase order → goods receipt (GRN) → bill → payment, plus purchase returns /
debit notes. Every step has a **"convert to"** endpoint that creates the next document as a draft from the
previous one, so lines are never typed twice:

| From        | Action                                                                                  | Creates                 |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------- |
| Requisition | `POST /requisitions/:id/convert-to-order` · `convert-to-rfq`                            | PO · RFQ                |
| RFQ         | `PUT /rfqs/:id/suppliers/:rfqSupplierId/quote` (record quotes) → `POST /rfqs/:id/award` | PO at the quoted prices |
| PO          | `POST /orders/:id/convert-to-receipt` (what is still to receive) · `convert-to-bill`    | GRN · bill              |
| GRN         | `POST /receipts/:id/convert-to-bill` · `convert-to-return`                              | bill · return           |
| Bill        | `POST /bills/:id/convert-to-debit-note`                                                 | debit note              |

- **PO statuses**: draft → pending_approval → approved → partially_received → received → billed, plus closed
  (short-close) and cancelled. Received/billed quantities are tracked per line in base units.
- **Approval levels by amount** (Settings → Purchase): an order needs every level whose minimum amount is at or
  below its total, in order; a level can require a role, and one person approves only one level per submission.
  The plan is snapshotted on submit; every approve/reject is kept in `purchase_approvals`. No levels = approved on
  submit.
- **GRN → stock**: posting a GRN puts the goods into stock through the inventory ledger (`purchase_receipt`) at
  `(line value + allocated landed cost) / base quantity`. Landed costs (freight, duty, insurance, handling, other)
  are spread by value or by quantity. Partial receiving is normal; receiving more than ordered is refused beyond the
  over-receipt tolerance.
- **Bills** are capped by received quantities (three-way match) and reject a supplier invoice number already used
  for that supplier. Payment status follows the payments and debit notes applied (`payable_allocations`).
- **Payments** post on save and settle several bills; the rest stays as an advance (`POST /payables/apply-credit`
  applies advances or debit notes later). Voiding a payment reopens its bills.
- **Returns** take stock out (`purchase_return`); **debit notes** are claims without stock. Both reduce the payable;
  a return from a GRN is applied to that GRN's bill automatically.
- **Payables**: `GET /suppliers/:id/ledger` (opening balance, bills, payments, returns, running balance),
  `/payables/outstanding` and `/payables/aging` (not due, 1–30, 31–60, 61–90, 90+ by due date, or 0–30 … by bill
  date; `asOf` for a past date).
- **Print / email**: `GET /orders/:id/print` returns the order, company and print template; the web app renders the
  A4 PDF and `POST /orders/:id/email` sends it as an attachment through the company SMTP (Settings → Email).
- Permissions: `purchase.view|create|update|approve|delete|print|export`. Store keepers (`purchase.create`) can
  complete and post GRNs and returns; payments also accept `accounting.create` / `accounting.approve`.

On an existing database run `npm run db:migrate` and the number-series seeder:
`npx sequelize-cli db:seed --seed 20261023000001-purchase-demo.js`.

## Sales (`/api/v1/sales/...`)

Quotation → sales order → delivery challan (partial) → invoice → money receipt, plus sales returns / credit
notes. As in Purchase, each step has a **"convert to"** endpoint that drafts the next document:

| From      | Action                                                                                 | Creates           |
| --------- | -------------------------------------------------------------------------------------- | ----------------- |
| Quotation | `POST /quotations/:id/convert-to-order` · `convert-to-invoice` (body `{ warehouseId }`) | order · invoice   |
| Order     | `POST /orders/:id/convert-to-challan` (what is still to deliver) · `convert-to-invoice` | challan · invoice |
| Challan   | `POST /challans/:id/convert-to-invoice`                                                | invoice           |
| Invoice   | `POST /invoices/:id/convert-to-return` (`{ type: 'return' \| 'credit_note' }`)          | return            |

- **Prices**: `POST /prices` resolves the selling price per customer — the highest-priority active price list of
  the customer's group (fixed price or % off, optional minimum quantity, per unit), else the pack / variant /
  product sale price. Leave `unitPrice` out of a line to take that price.
- **Discounts, tax, rounding**: each line has a % or fixed discount; a document discount (% or fixed) is spread
  over the lines by value before tax. Tax groups work tax-exclusive or inclusive. The total is rounded per
  Settings → Sales (none / 0.50 / 1 / 5 / 10; nearest, up or down) and the difference is stored as `roundOff`.
  `POST /calculate` previews all of it while a form is edited.
- **Credit limit**: confirming an order and posting an invoice check `outstanding + amount ≤ creditLimit`
  (0 = no limit; can be turned off in Settings → Sales). Over the limit the API answers `422` with the field
  `creditOverride`; a user with `sales.approve` can resend with `{ creditOverride: { reason } }`. The override is
  logged in `credit_overrides`.
- **Stock**: posting a challan takes goods out (`sale`); posting an invoice takes out only the lines that no
  challan delivered (so a direct invoice sells from stock). Cost is FIFO / weighted average as configured.
  Returns put goods back (`sales_return`) at the original cost; credit notes move no stock.
- **Receipts** post on save and settle several invoices; the rest is an advance
  (`POST /receivables/apply-credit` applies advances or credit notes later). Voiding a receipt reopens its invoices.
- **Receivables**: `GET /customers/:id/ledger`, `/customers/:id/open-items` and `/receivables/aging`
  (not due, 1–30, 31–60, 61–90, 90+ by due date, or by invoice date).
- **Invoice print / PDF**: `GET /invoices/:id/print` returns the invoice, branding (print template), amount in
  words in English and Bangla (lakh / crore) and a QR code (invoice no., date, total, BIN, seller, buyer). The web
  app renders the A4 page and turns it into a PDF in the browser (so Bangla text works); `POST /invoices/:id/email`
  sends it as an attachment.
- **Reminders**: `POST /invoices/:id/remind` emails the customer now. With reminders on in Settings → Sales, a job
  runs daily at 09:00 (Asia/Dhaka) for the configured days before / after the due date; each reminder is logged in
  `payment_reminders` and sent once.
- **Recurring invoices**: `POST /invoices/:id/make-recurring` (weekly / monthly / quarterly / yearly, every N);
  a job at 01:00 creates the due invoices (optionally posts and emails them). `POST /recurring/:id/run` creates
  the next one now.
- `GET /lookups` gives the forms tax groups, payment methods, customer groups and the sales settings.
- Permissions: `sales.view|create|update|approve|delete|print|export`. Receipts also accept `accounting.create` /
  `accounting.approve`; the inventory item search, warehouses and batches are open to `sales.view` and
  `purchase.view` too.

On an existing database run `npm run db:migrate` and the demo price list seeder:
`npx sequelize-cli db:seed --seed 20261024000001-sales-demo.js`.

## Point of sale (`/api/v1/pos/...`)

The web app's `/pos` screen is a full-screen, touch-friendly till. A POS sale is an ordinary posted sales
invoice (`channel = 'pos'`, numbered from the `pos_sale` series, e.g. `POS-CTG-2610-000001`), so it shows up in
invoices, the customer ledger, receivables and stock reports like any other sale.

- **Registers** (`/registers`, Settings → POS) sell from one warehouse; the branch is the warehouse's. Each has a
  walk-in customer (used when the cashier picks none) and a receipt paper (80 mm thermal or A4).
- **Sessions (shifts)**: `POST /sessions` opens a register with the opening cash (one open session per register);
  `POST /sessions/:id/cash` records cash in / out with a reason; `GET /sessions/:id` returns the running X report;
  `POST /sessions/:id/close` takes the count per denomination and stores the Z report with
  expected = opening + cash received − cash refunded + cash in − cash out, and the variance.
- **Sales** (`POST /sales`) run in one transaction: invoice → post (stock out, FEFO batches picked automatically
  for lot-tracked items) → one money receipt per payment method (cash + card + bKash …). Only cash can exceed
  what's due; the difference is stored as `change_amount`. Walk-in sales must be paid in full; named customers can
  leave the rest on account (credit limit checked on that part). Cashiers without `pos.update` are held to
  Settings → POS (price changes, maximum discount %).
- **Offline**: the device caches `GET /bootstrap`, `/catalog` and `/customers` in IndexedDB, keeps selling with
  the same pricing maths (a parity check against the server is part of development), prints `OFF-…` receipts and
  queues the sales. `POST /sales/sync` creates them once each (idempotent by `clientUuid`); a synced offline sale
  may take stock below zero and is flagged `stock_warning`.
- **Returns / exchanges**: `GET /sales/lookup?number=` (receipt or offline number), then
  `POST /sales/:id/return` puts the goods back into the register's warehouse; `refund` pays it out of the drawer
  (recorded on the return, counted in the Z report), otherwise the credit is spent on the next sale through
  `credits: [{ returnId, amount }]`.
- **Held carts**: `POST /held`, `GET /held?registerId=`, `POST /held/:id/recall` (recalling removes it).
- Permissions: `pos.view` (open the POS, reports), `pos.create` (sell, shifts, returns, hold, quick customers),
  `pos.update` (prices and discounts above the cashier limit); registers need `settings.update`.
- Accounting entries: each sale, receipt, return, refund and stock movement posts its journal (see Accounting);
  closing a session posts the cash over / short.

On an existing database run `npm run db:migrate` and the demo registers seeder:
`npx sequelize-cli db:seed --seed 20261025000001-pos-demo.js`.

## Accounting (`/api/v1/accounting/...`)

Double-entry general ledger with **perpetual inventory**. Every journal is written by one function
(`postJournal()` in `modules/accounting/ledger.service.js`): it checks debits = credits and the period lock,
numbers the entry from the `journal_entry` series and stores lines per account / party / branch.

- **Chart of accounts** (`/accounts`, `/accounts/tree?balances=true`, `/accounts/options`): group accounts
  (headings) and ledger accounts (postable). A standard Bangladeshi trading chart is created for each company on
  first use (`chart.js`); accounts with a `system_key` are the defaults of automatic postings and cannot be
  deleted or retyped.
- **Automatic postings** (`posting.service.js`) run inside the document's own transaction; the modules only call
  `postSource()` / `unpostSource()`, and the stock engine calls `postStockJournal()` for every stock movement:

  | Event                           | Debit                                       | Credit                               |
  | ------------------------------- | ------------------------------------------- | ------------------------------------ |
  | Sales invoice / POS sale        | Receivable (total)                          | Sales (net) · VAT output · rounding  |
  | Sales return / credit note      | Sales returns · VAT output                  | Receivable                           |
  | Money receipt / POS refund      | Cash or bank / Receivable                   | Receivable / Cash or bank            |
  | Supplier bill                   | GRNI (goods) · purchased services · VAT in  | Payable                              |
  | Supplier payment                | Payable                                     | Cash or bank                         |
  | Purchase return / debit note    | Payable                                     | VAT input · GRNI · price variance    |
  | Stock movement (any document)   | Inventory ↔ COGS, GRNI (+ landed cost), adjustment, write-off, transit, opening equity | |
  | POS session close               | Cash ↔ cash over / short                    |                                      |
  | Party opening balance           | Receivable / payable ↔ opening balance equity |                                    |

  Postings are idempotent per (document, event); cancelling / voiding a document posts **reversing entries**
  dated today. The accounts used come from Settings → Accounting (`GET/PUT /mapping`, which also sets the cash /
  bank account of each payment method).
- **Journals** (`/journals`): manual entries as drafts or posted, balanced, on ledger accounts; receivable /
  payable lines need the party. Posted entries are corrected with `POST /journals/:id/reverse` (automatic ones
  only through their document). `GET /journals/source/:sourceType/:sourceId` lists a document's journals.
- **Opening balances** (`GET/PUT /opening-balances`): one entry, replaced on save (the old one is reversed); the
  difference goes to Opening Balance Equity. Customers / suppliers and stock use their own opening balances.
- **Fiscal years** (`/fiscal-years`, `PATCH /periods/:id`): monthly periods; a locked period refuses every
  posting dated in it, documents included. `POST /fiscal-years/:id/close` locks all periods and posts the closing
  entry (income / expense → retained earnings, per branch); `/reopen` reverses it.
- **Ledger health** (`GET /reconciliation`): trial balance, receivable / payable control accounts per party
  against the Sales / Purchase document balances, inventory against the stock valuation, transit against
  dispatched transfers. `POST /backfill` posts journals missing for older documents.
- **Cash & bank accounts** (`/bank-accounts`, `/bank-accounts/options`): cash, bank and mobile-wallet accounts.
  Each is backed by a ledger account — an existing cash / bank ledger, or a new one created next to the standard
  account of its kind (1111…, 1121…, 1131…). Balances come from the ledger.
- **Vouchers** (`/vouchers`): `receipt` (Dr cash / bank, Cr the lines), `payment` (Dr the lines, Cr cash / bank) and
  `contra` (between own accounts). Draft → post → void (reversing entry). Receivable / payable accounts are refused
  on lines: customer and supplier money goes through money receipts and supplier payments.
- **Expenses** (`/expense-categories`, `/expenses`): paid straight from a cash / bank account (bills on credit go
  through Purchase → bills). Dr the category's expense account + VAT input, Cr cash / bank. Receipts are attached
  with `POST /attachments/expense/:id` (PDF / JPG / PNG / WEBP, field `files`); files are stored in
  `storage/attachments/` (not public) and served only by `GET /attachments/:id` to users with `accounting.view`.
- **Cheques** (`/cheques`): a money receipt or supplier payment through a payment method of type `cheque` adds a
  cheque (its reference is the cheque number). Received: in hand (Dr Cheques in Hand) → deposit → clear (Dr bank,
  Cr Cheques in Hand). Issued: credited to the bank on payment, cleared for the record. **Bounce** voids the
  receipt / payment in the same transaction (and reverses a clearing), so the amount is owed again; voiding the
  receipt by hand cancels an open cheque.
- **Bank reconciliation** (`/reconciliations`): start with the statement date and closing balance, tick ledger
  lines or import the statement (`POST /:id/statement`, CSV / XLSX; without `mapping` it returns a preview; the
  column mapping is remembered per account), `auto-match` (same amount, reference or nearest date within 10 days),
  `book` statement-only lines (charges, interest) as a voucher, and `complete` when
  previous statement balance + cleared lines = statement balance. Matched lines can't be voided.
- **Financial reports** (`/reports/...`, all take `branchId`): `trial-balance` (from, to), `profit-loss` (from, to,
  compareFrom / compareTo), `balance-sheet` (asOf, compareAsOf; unclosed profit shown as current year earnings),
  `cash-flow` (indirect method; ties to the change in cash / bank), `general-ledger` (accountId, comma-separated),
  `day-book` (paged) and `vat` (output / input by tax group from the documents, net payable). Year-closing entries
  are left out of P&L and cash flow. Export to Excel / PDF / CSV is done in the web app.
- Permissions: `accounting.view`, `.create` (journals, years, vouchers, expenses, reconciliations), `.update`
  (accounts, drafts, opening balances, mapping, cheque deposit / clear, matching), `.approve` (reverse, void,
  bounce, lock / unlock, close / reopen, complete reconciliations, backfill), `.delete`, `.export`.

On an existing database run `npm run db:migrate`, then post the journals of documents recorded before
accounting existed (safe to repeat — documents that have their journal are skipped):

```bash
npm run accounting:backfill            # every company (or: npm run accounting:backfill -- HOLYDEEN)
npx sequelize-cli db:seed --seed 20261026000001-accounting-demo.js   # + fiscal year and demo journals
```

## Manufacturing (`/api/v1/manufacturing/...`)

Bills of materials, work centers and manufacturing orders, with stock and the ledger moving at each step. Finished
goods are received at **actual cost**; the BOM's standard cost is kept on the order for comparison.

- **Work centers** (`/work-centers`, CRUD): daily capacity and hourly labour / overhead rates used for costing.
- **BOMs** (`/boms`): one product (or variant) made from components in their base unit with a wastage %, optional
  by-products (each with a cost share %), a routing of operations (work center, setup minutes per order, run
  minutes per output quantity) and quality checkpoints. Drafts are editable; `POST /boms/:id/activate` makes one
  read-only and the product's default; changes go through `POST /boms/:id/new-version` (code `…-V2`). A component
  with its own active BOM is a sub-assembly: `GET /boms/:id` rolls its standard cost up through every level and
  `GET /boms/:id/tree?quantity=` returns the exploded tree. Serial-tracked items cannot be manufactured yet.
- **Orders** (`/orders`, numbered from `production_order`, e.g. `MO-2026-00001`):
  `draft → confirm → issue → start → (operations) → submit → quality → complete → close`, plus `cancel` (nothing
  issued), `return` (unused material), `scrap` (wastage log), `reopen` (closed → completed) and
  `PATCH /orders/:id/schedule`. Saving copies the BOM's materials (wastage included) and routing onto the order.
  `POST /orders/from-sales-order` drafts orders for the undelivered lines of a confirmed sales order whose products
  have a BOM.
- **Stock and ledger**: issuing materials is a `production_issue` movement (Dr WIP 1168, Cr Inventory; lot-tracked
  items are picked FEFO) and returns are `production_return`. Finishing an operation charges minutes × rates:
  Dr WIP, Cr *Production Labour & Overhead Applied* (5180). Completing receives the good units
  (`production_receipt`) and by-products (`production_byproduct`) at actual cost (Dr Inventory, Cr WIP); units
  that failed QC and were scrapped keep their share in WIP. Closing posts what is left in WIP to *Production
  Variance & Wastage* (5175). All journals of an order are under source `manufacturing_order`.
- **Quality**: every BOM checkpoint must be recorded before completing. A failed check either scraps the failed
  units or sends them back for rework (the order returns to in progress).
- **Planning**: `GET /mrp` compares what open orders still need with stock on hand, open purchase orders, open
  requisitions and orders in production; `POST /mrp/requisition` creates a **draft** purchase requisition for the
  chosen shortages and `POST /mrp/sub-assemblies` drafts orders for made items. `GET /schedule?from=&to=` feeds
  the Gantt view.
- **Reports** (`GET /reports/:name?from=&to=`): `production`, `consumption` (planned vs used), `wastage`,
  `cost-variance` (material / labour / overhead) and `work-centers` (utilisation against capacity).
- Permissions: `manufacturing.view`, `.create` (BOMs, orders, MRP requisitions / sub-assembly orders), `.update`
  (drafts, issue / return, operations, QC, scrap), `.approve` (activate / archive BOMs; confirm, cancel, complete,
  close, reopen orders), `.delete`, `.export`.

On an existing database run `npm run db:migrate` (it also adds accounts 5175 and 5180 to existing charts) and the
demo seeder: `npx sequelize-cli db:seed --seed 20261028000001-manufacturing-demo.js`.

## Dashboard (`/api/v1/dashboard/...`)

`GET /kpis`, `GET /charts` and `GET /widgets` (permission `dashboard.view`) take `range=today|week|month|custom`
(`from` / `to` for custom, at most a year; the week starts on Saturday) and an optional `branchId` — otherwise the
topbar branch (`X-Branch-Id`), otherwise all the user's branches. Every KPI comes with the previous period of the
same length (`previous`, `changePercent`).

- **KPIs**: sales (net revenue from the ledger), purchases (posted supplier bills, before VAT), gross profit
  (sales − cost of goods), receivables, payables and cash & bank (ledger balances at the end of the period), stock
  value (stock movements up to that day) and open production orders (with how many are late).
- **Charts**: sales vs purchases per day (per month for periods over two months), sales by category, top 10
  products, profit for the last 12 months, production output.
- **Widgets**: overdue invoices, documents waiting for the user's approval (each with its module's own
  `approvePath`), recent activity, the cashier's own POS sales today and open shift. Stock alerts come from
  `GET /inventory/alerts`. Asset maintenance appears once the Fixed Assets module exists.
- **Role-based**: each part is only built when the user may see it — money figures need `accounting.view`; sales
  and purchase figures need `sales.view` / `purchase.view` plus `reports.view` or `accounting.view`; stock value
  `inventory.view` plus reports; production `manufacturing.view`; the POS card `pos.view`. Users without reports
  access only see their own recent activity. So a cashier sees their POS day, a store keeper stock and purchases,
  a production manager production and stock.
- Aggregated SQL only; results are cached in memory for a minute per company, branches, period and permissions
  (`refresh=true` skips the cache).

## Running the tests

Tests **drop and recreate every table**, then re-seed. Use a separate empty database:

1. Create an empty database (e.g. `holydeen_erp_test`; on Hostinger create it in hPanel → MySQL Databases and
   give your user access). Docker users already have one — `docker/mysql/init` creates it.
2. Set `DB_NAME_TEST` in `.env` to that database's name (it must differ from `DB_NAME`).
3. `npm test` — migrations and seeders run automatically before the suite.

The suite refuses to start if `DB_NAME_TEST` is missing or equal to `DB_NAME` — unless `TEST_ALLOW_MAIN_DB=true`,
which lets it wipe and re-seed `DB_NAME` (development databases only; afterwards it is re-seeded with clean demo
data). The full suite takes ~10 minutes against a remote database; run one file with
`npm test -- tests/settings.test.js`.

## Structure

```
app.js, server.js        Express app / process entry
src/
  config/                env (Zod-validated), db, logger, mailer, swagger, database.cjs (sequelize-cli)
  models.js              model registry — every model and association, import models from here
  modules/<module>/      routes → validation → controller → service → model
    auth/                login, refresh rotation, 2FA, password reset, sessions, login history
    users/ roles/        user CRUD, roles + permission matrix, permission.catalog.cjs
    companies/ branches/ tenant models (branch CRUD comes with the Settings module)
  middlewares/           auth (authenticate), rbac (authorize, branchScope), upload, error handler,
                         rate limit, sanitize, validate
  utils/                 AppError, apiResponse, pagination, crypto, device, slug, time, validation,
                         model.js, migration.cjs
  routes.js              mounts modules under /api/v1
  migrations/, seeders/  sequelize-cli (CommonJS)
uploads/                 user uploads (avatars), served at /uploads — not committed
tests/                   Jest + Supertest (globalSetup rebuilds the test DB)
docker/mysql/init/       SQL run on the first MySQL container start (creates the test DB)
```

## Conventions

- Responses: `{ success, message, data, meta? }`; list endpoints use `parseListQuery()` for pagination, sort, filter and search.
- Errors: throw `AppError`; one central handler formats them (no stack traces in production).
- Schema changes only via migrations. Every table has `company_id` (+ `branch_id`), audit columns and
  `deleted_at`; money and quantities are `DECIMAL(18,4)`. Column helpers: `src/utils/migration.cjs`.
- Logs: winston, rotated daily into `logs/`.
