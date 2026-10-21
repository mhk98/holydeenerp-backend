import { Op } from 'sequelize';
import { logger } from '../../config/logger.js';
import { Company, Party, PaymentReminder, SalesInvoice } from '../../models.js';
import { sendCompanyMail } from '../settings/mail.service.js';
import { getSettings } from '../settings/settings.service.js';
import { D, addDays } from './sales.common.js';

/**
 * Payment reminders by email: sent by hand from an invoice, or automatically each morning for
 * open invoices N days before / after their due date (Settings → Sales). Every attempt is logged
 * in payment_reminders, which also stops the same automatic reminder going out twice.
 */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const money = (v) => D(v).toFixed(2);

function reminderMail({ company, customer, invoice, today, message }) {
  const balance = D(invoice.total).minus(invoice.paidAmount);
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / 86_400_000,
  );
  const when = days > 0 ? `${days} day(s) overdue` : days === 0 ? 'due today' : `due in ${-days} day(s)`;
  const subject = `Payment reminder: invoice ${invoice.number} (${when})`;
  const intro =
    message ||
    `Dear ${customer.name},\n\nThis is a friendly reminder that invoice ${invoice.number} is ${when}. ` +
      'Please arrange payment at your earliest convenience. If you have already paid, kindly ignore this message.';
  const rows = [
    ['Invoice', invoice.number],
    ['Invoice date', invoice.invoiceDate],
    ['Due date', invoice.dueDate],
    ['Invoice total', `BDT ${money(invoice.total)}`],
    ['Paid', `BDT ${money(invoice.paidAmount)}`],
    ['Balance due', `BDT ${money(balance)}`],
  ];
  const text = `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${company.name}`;
  const html = `<div style="font-family:sans-serif;font-size:14px;color:#111">
<p style="white-space:pre-wrap">${escape(intro)}</p>
<table style="border-collapse:collapse;margin:12px 0">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${escape(k)}</td><td style="padding:4px 0;font-weight:600">${escape(v)}</td></tr>`,
    )
    .join('')}</table>
<p>${escape(company.name)}${company.phone ? ` · ${escape(company.phone)}` : ''}</p></div>`;
  return { subject, text, html };
}

/** Send one reminder and log it. Returns the log row ({ status, error }). */
export async function sendInvoiceReminder(invoice, { kind, offsetDays = null, to, message, userId = null }) {
  const [company, customer] = await Promise.all([
    Company.findByPk(invoice.companyId, { attributes: ['name', 'phone', 'timezone'] }),
    Party.findByPk(invoice.customerId, { attributes: ['name', 'email'] }),
  ]);
  const recipients = (to?.length ? to : [customer.email]).filter(Boolean);
  const log = (status, error = null) =>
    PaymentReminder.create({
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      kind,
      offsetDays,
      sentTo: recipients.join(', ') || '—',
      status,
      error,
      userId,
    });
  if (!recipients.length) return log('failed', 'The customer has no email address');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: company.timezone ?? 'Asia/Dhaka' }).format(
    new Date(),
  );
  try {
    await sendCompanyMail(invoice.companyId, {
      to: recipients,
      ...reminderMail({ company, customer, invoice, today, message }),
    });
    await invoice.update({ lastReminderAt: new Date() });
    return log('sent');
  } catch (err) {
    logger.warn(`Reminder for ${invoice.number} failed: ${err.message}`);
    return log('failed', err.message.slice(0, 500));
  }
}

/**
 * Automatic reminders for every company that enabled them. `today` (YYYY-MM-DD) is passed in so
 * tests can run a given day. Returns how many reminders were sent.
 */
export async function runAutomaticReminders(today) {
  const companies = await Company.findAll({ attributes: ['id'] });
  let sent = 0;
  for (const { id: companyId } of companies) {
    const settings = await getSettings(companyId, 'sales');
    if (!settings.remindersEnabled) continue;
    const plan = [
      ...settings.reminderDaysBefore.map((d) => ({
        kind: 'before_due',
        offset: d,
        dueDate: addDays(today, d),
      })),
      ...settings.reminderDaysAfter.map((d) => ({
        kind: 'after_due',
        offset: d,
        dueDate: addDays(today, -d),
      })),
    ];
    for (const step of plan) {
      const invoices = await SalesInvoice.findAll({
        where: { companyId, status: { [Op.in]: ['unpaid', 'partially_paid'] }, dueDate: step.dueDate },
      });
      for (const invoice of invoices) {
        const done = await PaymentReminder.count({
          where: { invoiceId: invoice.id, kind: step.kind, offsetDays: step.offset, status: 'sent' },
        });
        if (done) continue;
        const result = await sendInvoiceReminder(invoice, { kind: step.kind, offsetDays: step.offset });
        if (result.status === 'sent') sent += 1;
      }
    }
  }
  return sent;
}
