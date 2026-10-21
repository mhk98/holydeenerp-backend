# Holydeen ERP — Backend (project rules)

Production-grade, multi-tenant-ready ERP. This repo is the REST API; the web app is the sibling repo
`../holydeenerp-frontend` (it has its own CLAUDE.md with the frontend rules). Follow these rules in every task.

## Stack
Node.js 20+, Express 5, Sequelize 6, MySQL 8 / MariaDB (mysql2), ES modules. Zod for validation, decimal.js for
money maths, winston + morgan logging, Swagger at `/api/docs`, Jest + Supertest tests. API under `/api/v1`.

## Structure
```
app.js, server.js
src/config/        env (Zod-validated), db, logger, mailer, swagger, database.cjs (sequelize-cli)
src/models.js      model registry — every model and association; services import models from here
src/modules/<m>/   <m>.routes.js → <m>.validation.js → controller (or inline handlers) → <m>.service.js → model
src/middlewares/   auth, rbac (authorize, branchScope), validate, error handler, rate limit, sanitize, upload
src/utils/         AppError, apiResponse, pagination (parseListQuery), crud (createCrudService/Router), docs, model, migration.cjs
src/migrations/, src/seeders/   sequelize-cli (CommonJS)
tests/             Jest + Supertest
```

## Backend rules
- Layered: route → validation (Zod, `validate()` middleware) → controller → service → model. No business logic in
  routes/controllers.
- Schema changes only via migrations. Never `sync({ alter: true })`.
- Money and quantities: `DECIMAL(18,4)` (`money()` / `quantity()` helpers), handled as strings and computed with
  decimal.js. Never floats.
- Every table: BIGINT id, `company_id`, `branch_id` where relevant, `created_by`, `updated_by`, `created_at`,
  `updated_at`, `deleted_at` (paranoid). Exception: append-only ledgers (e.g. `stock_movements`) have no
  update/delete columns and refuse updates.
- Multi-table writes in `sequelize.transaction`; anything touching stock goes through
  `src/modules/inventory/stock.engine.js` (row-locked balances). Document numbers via `nextNumber()` inside the same
  transaction.
- Response envelope `{ success, message, data, meta: { page, limit, total, totalPages } }` (`sendSuccess`,
  `sendCreated`, `sendPaginated`).
- Every list endpoint: server-side pagination, sorting, filtering and search (`parseListQuery`, whitelisted fields).
- Errors: throw `AppError`; one central handler; no stack traces in production.
- Security: helmet, CORS whitelist, rate limiting, bcrypt, JWT access (15 min) + rotating refresh token (7 d,
  httpOnly cookie), input sanitization, parameterised queries only (no string-built SQL with user input).
- Permissions are `<module>.<action>` (`src/modules/roles/permission.catalog.cjs`); protect routes with
  `authorize(...)`, scope branch data with `branchScope` / `ctx.branchIds`.
- Document every route in Swagger with `documentRoutes()` (generated from the Zod schemas).
- Config via dotenv; keep `.env.example` in sync. Logs: winston daily rotate.

## Workflow rules
- One module at a time. Before coding a module, show a short plan (tables, endpoints, pages) and wait for approval.
- After each module: seeders with realistic demo data, Jest + Supertest API tests, and exact run/test steps.
- Never delete or rewrite working code from earlier modules unless asked.
- Keep code DRY — add shared helpers instead of duplicating.
- Match the surrounding code style; run `npx eslint .` and Prettier on changed files.
- Update README when a module adds endpoints, settings or setup steps.

## Gotchas
- `npm test` drops and re-seeds the database named by `DB_NAME_TEST` — or the main DB when
  `TEST_ALLOW_MAIN_DB=true`. Check `.env` before running tests; never point it at data you want to keep.
- The dev database is remote (~300 ms per query): long API tests need explicit timeouts (e.g. `180_000`).
- `.gitignore` patterns must be anchored (`/backups/`, not `backups/`) so they don't swallow `src/modules/<name>/`.
