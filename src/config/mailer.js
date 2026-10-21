import nodemailer from 'nodemailer';
import { env } from './env.js';
import { logger } from './logger.js';

const smtpConfigured = Boolean(env.SMTP_HOST);

// Without SMTP (development/tests) emails are rendered to JSON and logged instead of sent.
const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

/**
 * Send an email. Failures are logged and re-thrown so callers decide whether
 * they are fatal (most auth flows deliberately swallow them to avoid leaking info).
 */
export async function sendMail({ to, cc, subject, html, text, attachments }) {
  const info = await transporter.sendMail({
    from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM_EMAIL },
    to,
    cc,
    subject,
    html,
    text,
    attachments,
  });
  if (!smtpConfigured) {
    const files = attachments?.length ? ` attachments=${attachments.map((a) => a.filename).join(',')}` : '';
    logger.info(`[mail:dev] to=${to} subject="${subject}"${files}\n${text}`);
  }
  return info;
}
