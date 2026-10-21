import { z } from 'zod';
import { authorize } from '../../middlewares/rbac.js';
import { excelUpload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { AppError } from '../../utils/AppError.js';
import { sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { exportFor, runImport, templateFor } from './import.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const stamp = () => new Date().toISOString().slice(0, 10);

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

const importQuery = z.object({
  mode: z.enum(['validate', 'report', 'commit']).default('validate'),
  skipInvalid: z.enum(['true', 'false']).default('false'),
});

/**
 * Adds to an (already authenticated) router:
 *   GET  /import/template   Excel template
 *   POST /import            ?mode=validate|report|commit (&skipInvalid=true), multipart field "file"
 *   GET  /export            all records in template format
 */
export function mountImportExport(router, def, { permission, basePath, tag }) {
  router.get('/import/template', authorize(`${permission}.create`), async (req, res) =>
    sendXlsx(res, await templateFor(def), `${def.entity}-template.xlsx`),
  );

  router.post(
    '/import',
    authorize(`${permission}.create`),
    validate({ query: importQuery }),
    excelUpload,
    async (req, res) => {
      if (!req.file) throw AppError.badRequest('Choose an Excel file to import');
      const { mode, skipInvalid } = req.validated.query;
      const result = await runImport(ctxOf(req), def, req.file.buffer, {
        mode,
        skipInvalid: skipInvalid === 'true',
      });
      if (result.report) return sendXlsx(res, result.report, `${def.entity}-errors-${stamp()}.xlsx`);
      const s = result.summary;
      const message =
        mode === 'commit'
          ? `Imported: ${s.created} created, ${s.updated} updated${s.failed?.length ? `, ${s.failed.length} failed` : ''}`
          : `${s.valid} of ${s.total} rows are valid`;
      return sendSuccess(res, { data: s, message });
    },
  );

  router.get('/export', authorize(`${permission}.export`), async (req, res) =>
    sendXlsx(res, await exportFor(ctxOf(req), def, req.query), `${def.entity}-${stamp()}.xlsx`),
  );

  documentRoutes(basePath, tag, [
    {
      method: 'get',
      path: '/import/template',
      summary: 'Download the Excel import template',
      permission: `${permission}.create`,
    },
    {
      method: 'post',
      path: '/import',
      summary:
        'Import from Excel (mode=validate | report | commit; skipInvalid=true imports only valid rows)',
      permission: `${permission}.create`,
      multipart: true,
      noCreate: true,
      query: [
        { in: 'query', name: 'mode', schema: { type: 'string', enum: ['validate', 'report', 'commit'] } },
        { in: 'query', name: 'skipInvalid', schema: { type: 'boolean' } },
      ],
    },
    {
      method: 'get',
      path: '/export',
      summary: 'Export all as Excel (re-importable)',
      permission: `${permission}.export`,
    },
  ]);
}
