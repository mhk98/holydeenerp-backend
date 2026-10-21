import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { AppError } from '../../utils/AppError.js';
import { D, fixed } from './ledger.service.js';

/**
 * Bank statement files (CSV or XLSX) → statement lines. Banks lay their statements out differently, so
 * the user maps the columns: { headerRow, date, description, reference, debit, credit | amount,
 * dateFormat }. Columns are 1-based indexes. Debit = money out, credit = money in (bank's view).
 */

export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
  'DD-MMM-YYYY',
  'DD.MM.YYYY',
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Cell value as plain text (or a Date for real date cells). */
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return String(v.text);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
  }
  return String(v).trim();
}

/** Rows of the first sheet as arrays of cell values. */
export async function readStatementRows(buffer, filename) {
  const workbook = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(filename)) {
      // Keep raw text: the user's date format decides how dates are read.
      await workbook.csv.read(Readable.from(buffer), { map: (value) => value });
    } else {
      await workbook.xlsx.load(buffer);
    }
  } catch {
    throw AppError.unprocessable('The file could not be read; upload the statement as CSV or Excel (.xlsx)');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw AppError.unprocessable('The file has no sheet');
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(cellValue);
    if (values.some((v) => v !== '')) rows.push(values);
  });
  return rows;
}

/** YYYY-MM-DD from a date cell or text in `format`; null if it is not a date. */
export function parseStatementDate(value, format) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value ?? '').trim();
  if (!s) return null;
  const parts = s.split(/[\s/.-]+/);
  let y;
  let m;
  let d;
  switch (format) {
    case 'YYYY-MM-DD':
      [y, m, d] = parts;
      break;
    case 'MM/DD/YYYY':
      [m, d, y] = parts;
      break;
    case 'DD-MMM-YYYY':
      [d, m, y] = parts;
      m = MONTHS.indexOf(String(m).slice(0, 3).toLowerCase()) + 1;
      break;
    default:
      [d, m, y] = parts;
  }
  y = Number(y);
  if (y < 100) y += 2000;
  m = Number(m);
  d = Number(d);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!y || !m || !d || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** "1,25,000.50", "(500)", "500 Dr", "-" → Decimal (null when empty). */
export function parseStatementAmount(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return D(value);
  let s = String(value).replace(/[,\s৳]|BDT|Tk\.?/gi, '');
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/dr$/i.test(s)) {
    sign = -1;
    s = s.slice(0, -2);
  } else if (/cr$/i.test(s)) s = s.slice(0, -2);
  if (!s || s === '-') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  return D(s).times(sign);
}

/**
 * Turn rows into statement lines with the mapping. Returns { lines, errors } — rows that are not
 * transactions (opening balance text, totals) are reported, not imported.
 */
export function mapStatementRows(rows, mapping) {
  const col = (row, n) => (n ? row[n - 1] : undefined);
  const lines = [];
  const errors = [];
  rows.slice(mapping.headerRow ?? 1).forEach((row, i) => {
    const rowNo = (mapping.headerRow ?? 1) + i + 1;
    const date = parseStatementDate(col(row, mapping.date), mapping.dateFormat);
    let amount;
    if (mapping.amount) {
      amount = parseStatementAmount(col(row, mapping.amount));
    } else {
      const debit = parseStatementAmount(col(row, mapping.debit));
      const credit = parseStatementAmount(col(row, mapping.credit));
      if (debit === undefined || credit === undefined) amount = undefined;
      else if (debit == null && credit == null) amount = null;
      else amount = D(credit ?? 0).minus((debit ?? D(0)).abs());
    }
    if (!date || amount == null || amount === undefined || amount.isZero()) {
      errors.push({ row: rowNo, message: !date ? 'No valid date' : 'No amount' });
      return;
    }
    lines.push({
      lineDate: date,
      description: String(col(row, mapping.description) ?? '').slice(0, 255) || null,
      reference: String(col(row, mapping.reference) ?? '').slice(0, 100) || null,
      amount: fixed(amount),
    });
  });
  return { lines, errors };
}
