import { AppError } from '../../utils/AppError.js';
import { buildErrorReport, buildExport, buildTemplate, readRows } from '../../utils/excel.js';

export const MAX_ROWS = 5000;

/**
 * Generic Excel import. A definition (see definitions.js) supplies:
 *   columns, sheetName, examples, instructions
 *   prepare(ctx, rows)            → lookups (code → id maps, existing records)
 *   order?(rows)                  → processing order (e.g. parents before children)
 *   validateRow(ctx, values, lk)  → { payload, existingId, key, errors[] }
 *   save(ctx, payload, existingId, lk) → persists one row
 *   exportRecords(ctx, query)     → records for export
 *
 * mode = "validate" → summary only · "report" → annotated .xlsx · "commit" → save rows.
 * Rows are saved one by one (each in its own transaction) so one bad row can't undo the rest.
 */
export async function runImport(ctx, def, buffer, { mode = 'validate', skipInvalid = false } = {}) {
  const parsed = await readRows(buffer, def.columns);
  if (parsed.error) throw AppError.badRequest(parsed.error);
  if (parsed.missing.length) {
    throw AppError.unprocessable(
      `Missing required column(s): ${parsed.missing.join(', ')}. Download the template.`,
    );
  }
  if (!parsed.rows.length) throw AppError.badRequest('The file has no data rows');
  if (parsed.rows.length > MAX_ROWS) throw AppError.badRequest(`At most ${MAX_ROWS} rows per file`);

  const lookups = await def.prepare(ctx, parsed.rows);
  const ordered = def.order ? def.order(parsed.rows) : parsed.rows;

  const results = [];
  const seenKeys = new Map();
  for (const row of ordered) {
    const result = await def.validateRow(ctx, row.values, lookups);
    if (result.key) {
      const k = result.key.toUpperCase();
      if (seenKeys.has(k)) result.errors.push(`Duplicate of row ${seenKeys.get(k)}`);
      else seenKeys.set(k, row.rowNumber);
    }
    results.push({ rowNumber: row.rowNumber, ...result });
  }

  const invalid = results.filter((r) => r.errors.length);
  const valid = results.filter((r) => !r.errors.length);
  const summary = {
    total: results.length,
    valid: valid.length,
    invalid: invalid.length,
    toCreate: valid.filter((r) => !r.existingId).length,
    toUpdate: valid.filter((r) => r.existingId).length,
    errors: invalid
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .slice(0, 200)
      .map((r) => ({ row: r.rowNumber, messages: r.errors })),
  };

  if (mode === 'validate') return { summary };
  if (mode === 'report') {
    return {
      report: await buildErrorReport(buffer, Object.fromEntries(invalid.map((r) => [r.rowNumber, r.errors]))),
    };
  }

  if (invalid.length && !skipInvalid) {
    throw AppError.unprocessable(
      `${invalid.length} row(s) have errors. Fix them, or import only the valid rows.`,
      summary.errors.map((e) => ({ field: `row ${e.row}`, message: e.messages.join('; ') })),
    );
  }

  let created = 0;
  let updated = 0;
  const failed = [];
  for (const r of valid) {
    try {
      await def.save(ctx, r.payload, r.existingId, lookups);
      if (r.existingId) updated += 1;
      else created += 1;
    } catch (err) {
      const detail = err.errors?.map((e) => e.message).join('; ');
      failed.push({ row: r.rowNumber, messages: [detail ? `${err.message}: ${detail}` : err.message] });
    }
  }
  return { summary: { ...summary, created, updated, skipped: invalid.length, failed } };
}

export function templateFor(def) {
  return buildTemplate({
    sheetName: def.sheetName,
    columns: def.columns,
    examples: def.examples,
    instructions: def.instructions,
  });
}

export async function exportFor(ctx, def, query) {
  return buildExport({
    sheetName: def.sheetName,
    columns: def.columns,
    records: await def.exportRecords(ctx, query),
  });
}

/** Zod issues → "Column: message" using the definition's field → header map. */
export function zodMessages(error, fieldToHeader) {
  return error.issues.map((i) => {
    const field = i.path[0];
    const header = fieldToHeader[field] ?? field ?? 'Row';
    return `${header}: ${i.message}`;
  });
}
