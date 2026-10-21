import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/auth.js';
import { authorize, requireSuperAdmin } from '../../middlewares/rbac.js';
import { imageUpload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { createCrudRouter } from '../../utils/crud.js';
import { documentRoutes } from '../../utils/docs.js';
import { idParams, idSchema } from '../../utils/validation.js';
import { branchCrud } from '../branches/branches.service.js';
import * as branchV from '../branches/branches.validation.js';
import { updateCompanySchema } from '../companies/company.validation.js';
import { currencyCrud } from '../currencies/currencies.service.js';
import * as currencyV from '../currencies/currencies.validation.js';
import { paymentMethodCrud } from '../payment-methods/payment-methods.service.js';
import * as paymentV from '../payment-methods/payment-methods.validation.js';
import { sequenceCrud } from '../sequences/sequences.service.js';
import * as sequenceV from '../sequences/sequences.validation.js';
import { taxGroupCrud, taxRateCrud } from '../taxes/taxes.service.js';
import * as taxV from '../taxes/taxes.validation.js';
import { unitCrud } from '../units/units.service.js';
import * as unitV from '../units/units.validation.js';
import { warehouseCrud } from '../warehouses/warehouses.service.js';
import * as warehouseV from '../warehouses/warehouses.validation.js';
import { printTemplateCrud } from './print-templates.service.js';
import * as templateV from './print-templates.validation.js';
import { PREFERENCE_GROUPS, SETTING_GROUPS } from './settings.groups.js';
import * as c from './settings.controller.js';

/**
 * Settings area — everything under /api/v1/settings. Reads need settings.view,
 * writes settings.create / settings.update / settings.delete. Backups: Super Admin only.
 */
const router = Router();
const P = '/settings';
const view = authorize('settings.view');
const edit = authorize('settings.update');

// ── App config (any signed-in user: formatting, theme) ─────────────────────
router.get('/app-config', authenticate, c.appConfig);

// ── Company profile ────────────────────────────────────────────────────────
const company = Router();
company.use(authenticate);
company.get('/', view, c.getCompany);
company.patch('/', edit, validate({ body: updateCompanySchema }), c.updateCompany);
company.post('/logo', edit, imageUpload('logos').single('logo'), c.uploadLogo);
company.delete('/logo', edit, c.removeLogo);
router.use('/company', company);

// ── Preferences (financial / system / smtp) ────────────────────────────────
const groupParams = z.object({ group: z.enum(PREFERENCE_GROUPS) });
const preferences = Router();
preferences.use(authenticate);
preferences.post(
  '/smtp/test',
  edit,
  validate({ body: z.object({ to: z.string().trim().email() }) }),
  c.testSmtp,
);
preferences.get('/:group', view, validate({ params: groupParams }), c.getPreferences);
preferences.put('/:group', edit, validate({ params: groupParams }), c.savePreferences);
router.use('/preferences', preferences);

// ── CRUD resources ─────────────────────────────────────────────────────────
const crud = (path, opts) =>
  router.use(path, createCrudRouter({ basePath: `${P}${path}`, permission: 'settings', ...opts }));

crud('/branches', {
  service: branchCrud,
  tag: 'Settings · Branches',
  label: 'Branch',
  createSchema: branchV.createBranchSchema,
  updateSchema: branchV.updateBranchSchema,
  listQuerySchema: branchV.listBranchQuery,
});

crud('/warehouses', {
  service: warehouseCrud,
  tag: 'Settings · Warehouses',
  label: 'Warehouse',
  branchScoped: true,
  createSchema: warehouseV.createWarehouseSchema,
  updateSchema: warehouseV.updateWarehouseSchema,
  listQuerySchema: warehouseV.listWarehouseQuery,
});

crud('/currencies', {
  service: currencyCrud,
  tag: 'Settings · Currencies',
  label: 'Currency',
  createSchema: currencyV.createCurrencySchema,
  updateSchema: currencyV.updateCurrencySchema,
  listQuerySchema: currencyV.listCurrencyQuery,
  extend: (r, { can }) => {
    r.get('/:id/rates', can('view'), validate({ params: idParams }), c.listRates);
    r.post(
      '/:id/rates',
      can('update'),
      validate({ params: idParams, body: currencyV.rateSchema }),
      c.setRate,
    );
    r.delete(
      '/:id/rates/:rateId',
      can('update'),
      validate({ params: z.object({ id: idSchema, rateId: idSchema }) }),
      c.deleteRate,
    );
  },
});

crud('/tax-rates', {
  service: taxRateCrud,
  tag: 'Settings · Taxes',
  label: 'Tax rate',
  createSchema: taxV.createTaxRateSchema,
  updateSchema: taxV.updateTaxRateSchema,
  listQuerySchema: taxV.listTaxRateQuery,
});

crud('/tax-groups', {
  service: taxGroupCrud,
  tag: 'Settings · Taxes',
  label: 'Tax group',
  createSchema: taxV.createTaxGroupSchema,
  updateSchema: taxV.updateTaxGroupSchema,
  listQuerySchema: taxV.listTaxGroupQuery,
  extend: (r, { can }) => {
    r.post(
      '/:id/calculate',
      can('view'),
      validate({ params: idParams, body: taxV.calculateSchema }),
      c.calculateTax,
    );
  },
});

crud('/document-sequences', {
  service: sequenceCrud,
  tag: 'Settings · Numbering',
  label: 'Number series',
  createSchema: sequenceV.createSequenceSchema,
  updateSchema: sequenceV.updateSequenceSchema,
  listQuerySchema: sequenceV.listSequenceQuery,
  extend: (r, { can }) => {
    r.post('/preview', can('view'), validate({ body: sequenceV.previewSchema }), c.previewDraft);
    r.get('/:id/preview', can('view'), validate({ params: idParams }), c.previewSequence);
  },
});

crud('/units', {
  service: unitCrud,
  tag: 'Settings · Units',
  label: 'Unit',
  createSchema: unitV.createUnitSchema,
  updateSchema: unitV.updateUnitSchema,
  listQuerySchema: unitV.listUnitQuery,
});

const conversions = Router();
conversions.use(authenticate);
conversions.get('/', view, validate({ query: unitV.listConversionQuery }), c.listConversions);
conversions.post(
  '/',
  authorize('settings.create'),
  validate({ body: unitV.createConversionSchema }),
  c.createConversion,
);
conversions.delete('/:id', authorize('settings.delete'), validate({ params: idParams }), c.deleteConversion);
router.use('/unit-conversions', conversions);

crud('/payment-methods', {
  service: paymentMethodCrud,
  tag: 'Settings · Payment methods',
  label: 'Payment method',
  createSchema: paymentV.createPaymentMethodSchema,
  updateSchema: paymentV.updatePaymentMethodSchema,
  listQuerySchema: paymentV.listPaymentMethodQuery,
});

crud('/print-templates', {
  service: printTemplateCrud,
  tag: 'Settings · Print templates',
  label: 'Print template',
  createSchema: templateV.createTemplateSchema,
  updateSchema: templateV.updateTemplateSchema,
  listQuerySchema: templateV.listTemplateQuery,
});

// ── Backups (whole database → Super Admin only) ────────────────────────────
const backups = Router();
backups.use(authenticate, requireSuperAdmin);
backups.get('/', c.listBackups);
backups.post('/', c.createBackup);
backups.get('/schedule', c.getBackupSchedule);
backups.put('/schedule', c.saveBackupSchedule);
backups.get('/:id/download', validate({ params: idParams }), c.downloadBackup);
backups.delete('/:id', validate({ params: idParams }), c.deleteBackup);
router.use('/backups', backups);

// ── Docs for the hand-written routes ───────────────────────────────────────
documentRoutes(P, 'Settings', [
  {
    method: 'get',
    path: '/app-config',
    summary: 'Formatting & theme settings for the web app (any signed-in user)',
  },
  { method: 'get', path: '/company', summary: 'Company profile', permission: 'settings.view' },
  {
    method: 'patch',
    path: '/company',
    summary: 'Update company profile',
    permission: 'settings.update',
    body: updateCompanySchema,
  },
  {
    method: 'post',
    path: '/company/logo',
    summary: 'Upload logo (multipart field "logo")',
    permission: 'settings.update',
    noCreate: true,
  },
  { method: 'delete', path: '/company/logo', summary: 'Remove logo', permission: 'settings.update' },
  {
    method: 'get',
    path: '/preferences/:group',
    summary: 'Read a settings group (financial | system | smtp)',
    permission: 'settings.view',
  },
  {
    method: 'put',
    path: '/preferences/:group',
    summary: 'Save part of a settings group',
    permission: 'settings.update',
    body: SETTING_GROUPS.financial.schema.partial(),
  },
  {
    method: 'post',
    path: '/preferences/smtp/test',
    summary: 'Send a test email with the saved SMTP settings',
    permission: 'settings.update',
    noCreate: true,
  },
  {
    method: 'get',
    path: '/currencies/:id/rates',
    summary: 'Exchange-rate history',
    permission: 'settings.view',
    list: true,
  },
  {
    method: 'post',
    path: '/currencies/:id/rates',
    summary: 'Add / replace the rate for a date',
    permission: 'settings.update',
    body: currencyV.rateSchema,
  },
  {
    method: 'delete',
    path: '/currencies/:id/rates/:rateId',
    summary: 'Delete a rate',
    permission: 'settings.update',
  },
  {
    method: 'post',
    path: '/tax-groups/:id/calculate',
    summary: 'Tax breakdown for an amount',
    permission: 'settings.view',
    body: taxV.calculateSchema,
    noCreate: true,
  },
  {
    method: 'post',
    path: '/document-sequences/preview',
    summary: 'Preview a number for unsaved series settings',
    permission: 'settings.view',
    body: sequenceV.previewSchema,
    noCreate: true,
  },
  {
    method: 'get',
    path: '/document-sequences/:id/preview',
    summary: 'Next number of a series (not consumed)',
    permission: 'settings.view',
  },
  {
    method: 'get',
    path: '/unit-conversions',
    summary: 'List unit conversions',
    permission: 'settings.view',
    list: true,
  },
  {
    method: 'post',
    path: '/unit-conversions',
    summary: 'Add a conversion (1 from = factor × to)',
    permission: 'settings.create',
    body: unitV.createConversionSchema,
  },
  {
    method: 'delete',
    path: '/unit-conversions/:id',
    summary: 'Delete a conversion',
    permission: 'settings.delete',
  },
  { method: 'get', path: '/backups', summary: 'List backups (Super Admin)', list: true },
  { method: 'post', path: '/backups', summary: 'Create a database backup now (Super Admin)' },
  { method: 'get', path: '/backups/:id/download', summary: 'Download a backup (.sql.gz)' },
  { method: 'delete', path: '/backups/:id', summary: 'Delete a backup' },
  { method: 'get', path: '/backups/schedule', summary: 'Backup schedule' },
  {
    method: 'put',
    path: '/backups/schedule',
    summary: 'Save backup schedule',
    body: SETTING_GROUPS.backup.schema.partial(),
  },
]);

export default router;
