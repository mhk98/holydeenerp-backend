import { env } from '../../config/env.js';

const COPY = {
  en: {
    subject: 'Reset your Holydeen ERP password',
    greeting: (name) => `Hello ${name},`,
    body: 'We received a request to reset your password. Click the button below to choose a new one.',
    button: 'Reset password',
    expiry: (m) =>
      `This link expires in ${m} minutes. If you did not request this, you can ignore this email.`,
  },
  bn: {
    subject: 'আপনার Holydeen ERP পাসওয়ার্ড রিসেট করুন',
    greeting: (name) => `প্রিয় ${name},`,
    body: 'আপনার পাসওয়ার্ড রিসেট করার একটি অনুরোধ পাওয়া গেছে। নতুন পাসওয়ার্ড দিতে নিচের বাটনে ক্লিক করুন।',
    button: 'পাসওয়ার্ড রিসেট করুন',
    expiry: (m) => `লিংকটি ${m} মিনিট পর্যন্ত কার্যকর থাকবে। আপনি অনুরোধ না করে থাকলে ইমেইলটি উপেক্ষা করুন।`,
  },
};

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export function passwordResetEmail({ name, language, token }) {
  const t = COPY[language] ?? COPY.en;
  const url = `${env.APP_URL.replace(/\/$/, '')}/reset-password/${token}`;
  const minutes = env.PASSWORD_RESET_EXPIRES_MINUTES;

  const text = [t.greeting(name), '', t.body, '', url, '', t.expiry(minutes)].join('\n');
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:'Hind Siliguri',Arial,sans-serif;color:#171717">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <tr><td>
      <p style="font-size:18px;font-weight:600;margin:0 0 16px">${escapeHtml(env.APP_NAME)}</p>
      <p>${escapeHtml(t.greeting(name))}</p>
      <p>${escapeHtml(t.body)}</p>
      <p style="margin:28px 0">
        <a href="${url}" style="background:#171717;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(t.button)}</a>
      </p>
      <p style="font-size:13px;color:#737373">${escapeHtml(t.expiry(minutes))}</p>
      <p style="font-size:12px;color:#a3a3a3;word-break:break-all">${url}</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject: t.subject, text, html };
}
