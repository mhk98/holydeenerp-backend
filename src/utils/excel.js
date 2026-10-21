import ExcelJS from 'exceljs';

/**
 * Excel helpers for import/export.
 *
 * Column definition: { key, header, required?, example?, note?, width?, export?(record) }
 * Templates, exports and error reports share the same header row, so an export can be
 * edited and re-imported.
 */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
const ERROR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

function addSheet(workbook, name, columns) {
  const sheet = workbook.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({
    header: c.required ? `${c.header} *` : c.header,
    key: c.key,
    width: c.width ?? Math.max(14, c.header.length + 4),
  }));
  styleHeader(sheet.getRow(1));
  columns.forEach((c, i) => {
    if (c.note) sheet.getRow(1).getCell(i + 1).note = c.note;
  });
  return sheet;
}

/** Template: header row, example rows and an "Instructions" sheet. */
export async function buildTemplate({ sheetName, columns, examples = [], instructions = [] }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = addSheet(workbook, sheetName, columns);
  for (const example of examples) sheet.addRow(example);

  const help = workbook.addWorksheet('Instructions');
  help.columns = [
    { header: 'Column', key: 'column', width: 26 },
    { header: 'Required', key: 'required', width: 10 },
    { header: 'Description', key: 'note', width: 90 },
  ];
  styleHeader(help.getRow(1));
  for (const c of columns)
    help.addRow({ column: c.header, required: c.required ? 'Yes' : '', note: c.note ?? '' });
  if (instructions.length) {
    help.addRow({});
    for (const line of instructions) help.addRow({ note: line });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Export rows in template format (re-importable). */
export async function buildExport({ sheetName, columns, records }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = addSheet(workbook, sheetName, columns);
  for (const record of records) {
    sheet.addRow(
      Object.fromEntries(columns.map((c) => [c.key, c.export ? c.export(record) : record[c.key]])),
    );
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Plain cell text: rich text, hyperlinks, formulas and dates normalised to strings. */
function cellValue(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText))
      return v.richText
        .map((r) => r.text)
        .join('')
        .trim();
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result).trim();
    if ('text' in v) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}

const normalise = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * Read the first worksheet. Columns are matched by header (case/space/asterisk-insensitive) or key.
 * Returns { rows: [{ rowNumber, values }], missing: [required headers not found] }.
 */
export async function readRows(buffer, columns) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { error: 'The file could not be read. Upload an .xlsx file made from the template.' };
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { error: 'The file has no worksheet.' };

  const header = sheet.getRow(1);
  const positions = {};
  header.eachCell((cell, col) => {
    const name = normalise(cellValue(cell));
    const column = columns.find((c) => normalise(c.header) === name || normalise(c.key) === name);
    if (column) positions[column.key] = col;
  });
  const missing = columns.filter((c) => c.required && !positions[c.key]).map((c) => c.header);

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = Object.fromEntries(
      Object.entries(positions).map(([key, col]) => [key, cellValue(row.getCell(col))]),
    );
    if (Object.values(values).some((v) => v !== '')) rows.push({ rowNumber, values });
  });
  return { rows, missing };
}

/** The uploaded workbook with an "Errors" column; rows with problems are highlighted. */
export async function buildErrorReport(buffer, errorsByRow) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const col = sheet.columnCount + 1;
  const head = sheet.getRow(1).getCell(col);
  head.value = 'Errors';
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB91C1C' } };
  sheet.getColumn(col).width = 70;

  for (const [rowNumber, messages] of Object.entries(errorsByRow)) {
    const row = sheet.getRow(Number(rowNumber));
    row.getCell(col).value = messages.join('; ');
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = ERROR_FILL;
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** "yes"/"no"/"true"/"1"… → boolean; '' → undefined. */
export function parseBool(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();
  if (v === '') return undefined;
  if (['yes', 'y', 'true', '1', 'হ্যাঁ'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'না'].includes(v)) return false;
  return null; // invalid
}

export const yesNo = (b) => (b ? 'yes' : 'no');
