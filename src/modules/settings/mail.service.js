import nodemailer from 'nodemailer';
import { sendMail as sendWithEnvTransport } from '../../config/mailer.js';
import { AppError } from '../../utils/AppError.js';
import { getSettings } from './settings.service.js';

function transportFrom(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  });
}

/**
 * Send mail for a company: through its own SMTP server when enabled in Settings → Email,
 * otherwise through the server-wide transport from .env (or the dev log).
 */
export async function sendCompanyMail(companyId, message) {
  const smtp = await getSettings(companyId, 'smtp');
  if (!smtp.enabled || !smtp.host) return sendWithEnvTransport(message);
  return transportFrom(smtp).sendMail({
    from: { name: smtp.fromName || smtp.fromEmail, address: smtp.fromEmail },
    ...message,
  });
}

/** Verify the saved SMTP settings and send a test message. Errors come back as 422 with the SMTP reason. */
export async function sendTestEmail(ctx, to) {
  const smtp = await getSettings(ctx.auth.companyId, 'smtp');
  if (!smtp.host || !smtp.fromEmail) throw AppError.unprocessable('Save the SMTP host and From email first');
  const transport = transportFrom(smtp);
  try {
    await transport.verify();
    await transport.sendMail({
      from: { name: smtp.fromName || smtp.fromEmail, address: smtp.fromEmail },
      to,
      subject: 'Holydeen ERP — test email',
      text: 'Your SMTP settings work. This is a test message from Holydeen ERP.',
      html: '<p>Your SMTP settings work. This is a test message from <strong>Holydeen ERP</strong>.</p>',
    });
  } catch (err) {
    throw AppError.unprocessable(`SMTP test failed: ${err.message}`);
  } finally {
    transport.close();
  }
}
