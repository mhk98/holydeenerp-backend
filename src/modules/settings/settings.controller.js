import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import { ctxOf } from '../../utils/crud.js';
import * as backups from '../backups/backups.service.js';
import { scheduleBackups } from '../backups/backups.scheduler.js';
import * as company from '../companies/company.service.js';
import * as currencies from '../currencies/currencies.service.js';
import * as sequences from '../sequences/sequences.service.js';
import * as taxes from '../taxes/taxes.service.js';
import * as units from '../units/units.service.js';
import { sendTestEmail } from './mail.service.js';
import * as settings from './settings.service.js';

const paginated = (res, { rows, count, page, limit }) => sendPaginated(res, { rows, count }, { page, limit });

// ── Company ────────────────────────────────────────────────────────────────
export const getCompany = async (req, res) =>
  sendSuccess(res, { data: await company.getCompany(ctxOf(req)) });
export const updateCompany = async (req, res) =>
  sendSuccess(res, {
    data: await company.updateCompany(ctxOf(req), req.validated.body),
    message: 'Company updated',
  });
export const uploadLogo = async (req, res) =>
  sendSuccess(res, { data: await company.updateLogo(ctxOf(req), req.file), message: 'Logo updated' });
export const removeLogo = async (req, res) =>
  sendSuccess(res, { data: await company.removeLogo(ctxOf(req)), message: 'Logo removed' });

// ── Preferences ────────────────────────────────────────────────────────────
export const getPreferences = async (req, res) =>
  sendSuccess(res, {
    data: await settings.getPublicSettings(req.auth.companyId, req.validated.params.group),
  });
export const savePreferences = async (req, res) =>
  sendSuccess(res, {
    data: await settings.saveSettings(ctxOf(req), req.validated.params.group, req.body),
    message: 'Settings saved',
  });
export const testSmtp = async (req, res) => {
  await sendTestEmail(ctxOf(req), req.validated.body.to);
  return sendSuccess(res, { message: `Test email sent to ${req.validated.body.to}` });
};
export const appConfig = async (req, res) =>
  sendSuccess(res, { data: await settings.getAppConfig(req.auth.companyId) });

// ── Exchange rates ─────────────────────────────────────────────────────────
export const listRates = async (req, res) =>
  paginated(res, await currencies.listRates(ctxOf(req), req.validated.params.id, req.query));
export const setRate = async (req, res) =>
  sendCreated(
    res,
    await currencies.setRate(ctxOf(req), req.validated.params.id, req.validated.body),
    'Rate saved',
  );
export const deleteRate = async (req, res) => {
  await currencies.deleteRate(ctxOf(req), req.validated.params.id, req.validated.params.rateId);
  return sendSuccess(res, { message: 'Rate deleted' });
};

// ── Taxes ──────────────────────────────────────────────────────────────────
export const calculateTax = async (req, res) =>
  sendSuccess(res, {
    data: await taxes.calculateForGroup(ctxOf(req), req.validated.params.id, req.validated.body),
  });

// ── Number series ──────────────────────────────────────────────────────────
export const previewSequence = async (req, res) =>
  sendSuccess(res, { data: await sequences.previewSequence(ctxOf(req), req.validated.params.id) });
export const previewDraft = async (req, res) =>
  sendSuccess(res, { data: await sequences.previewDraft(ctxOf(req), req.validated.body) });

// ── Unit conversions ───────────────────────────────────────────────────────
export const listConversions = async (req, res) =>
  paginated(res, await units.listConversions(ctxOf(req), req.validated.query));
export const createConversion = async (req, res) =>
  sendCreated(res, await units.createConversion(ctxOf(req), req.validated.body), 'Conversion added');
export const deleteConversion = async (req, res) => {
  await units.deleteConversion(ctxOf(req), req.validated.params.id);
  return sendSuccess(res, { message: 'Conversion deleted' });
};

// ── Backups (Super Admin) ──────────────────────────────────────────────────
export const listBackups = async (req, res) => paginated(res, await backups.listBackups(req.query));
export const createBackup = async (req, res) =>
  sendCreated(res, await backups.createBackup({ type: 'manual', userId: req.auth.userId }), 'Backup created');
export const downloadBackup = async (req, res) => {
  const { file, fileName } = await backups.backupFile(req.validated.params.id);
  return res.download(file, fileName);
};
export const deleteBackup = async (req, res) => {
  await backups.deleteBackup(req.validated.params.id);
  return sendSuccess(res, { message: 'Backup deleted' });
};
export const getBackupSchedule = async (req, res) =>
  sendSuccess(res, { data: await settings.getPublicSettings(null, 'backup') });
export const saveBackupSchedule = async (req, res) => {
  const data = await settings.saveSettings(ctxOf(req), 'backup', req.body);
  const expression = await scheduleBackups();
  return sendSuccess(res, { data: { ...data, cron: expression }, message: 'Backup schedule saved' });
};
