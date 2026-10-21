import { UAParser } from 'ua-parser-js';

/** Request metadata recorded with sessions and login history. */
export function requestMeta(req) {
  const userAgent = (req.get('user-agent') || '').slice(0, 500) || null;
  return { ip: req.ip || null, userAgent, deviceName: deviceName(userAgent) };
}

/** Human readable device label, e.g. "Chrome 141 on Windows 10". */
export function deviceName(userAgent) {
  if (!userAgent) return 'Unknown device';
  const { browser, os } = UAParser(userAgent);
  const b = [browser.name, browser.major].filter(Boolean).join(' ');
  const o = [os.name, os.version].filter(Boolean).join(' ');
  if (!b && !o) return userAgent.slice(0, 150);
  return [b || 'Unknown browser', o && `on ${o}`].filter(Boolean).join(' ').slice(0, 150);
}
