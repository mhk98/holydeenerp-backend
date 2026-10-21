import { sendSuccess } from '../../utils/apiResponse.js';
import { requestMeta } from '../../utils/device.js';
import * as authService from './auth.service.js';
import { REFRESH_COOKIE, refreshCookieOptions } from './token.service.js';

/** Put the refresh token in its httpOnly cookie and return the rest as the response body. */
function sendSession(res, { refreshToken, ...session }, message) {
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  return sendSuccess(res, { data: session, message });
}

function clearRefreshCookie(res) {
  // clearCookie must match the cookie's path/flags; maxAge would make it set a fresh expiry.
  const opts = refreshCookieOptions();
  delete opts.maxAge;
  res.clearCookie(REFRESH_COOKIE, opts);
}

export async function login(req, res) {
  const result = await authService.login(req.validated.body, requestMeta(req));
  if (result.requiresTwoFactor)
    return sendSuccess(res, { data: result, message: 'Verification code required' });
  return sendSession(res, result, 'Signed in successfully');
}

export async function verifyTwoFactor(req, res) {
  const result = await authService.verifyTwoFactorLogin(req.validated.body, requestMeta(req));
  return sendSession(res, result, 'Signed in successfully');
}

export async function refresh(req, res) {
  try {
    const result = await authService.refresh(req.cookies?.[REFRESH_COOKIE], requestMeta(req));
    return sendSession(res, result, 'Session refreshed');
  } catch (err) {
    clearRefreshCookie(res);
    throw err;
  }
}

export async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  return sendSuccess(res, { message: 'Signed out successfully' });
}

export function me(req, res) {
  return sendSuccess(res, { data: authService.me(req.auth.ctx) });
}

export async function changePassword(req, res) {
  await authService.changePassword(req.auth.userId, req.auth.sessionId, req.validated.body);
  return sendSuccess(res, { message: 'Password changed. Other devices have been signed out.' });
}

export async function forgotPassword(req, res) {
  await authService.forgotPassword(req.validated.body);
  return sendSuccess(res, { message: 'If an account exists for that email, a reset link has been sent.' });
}

export async function checkResetToken(req, res) {
  const data = await authService.checkResetToken(req.validated.params.token);
  return sendSuccess(res, { data, message: 'Reset link is valid' });
}

export async function resetPassword(req, res) {
  await authService.resetPassword(req.validated.body);
  return sendSuccess(res, { message: 'Password has been reset. You can now sign in.' });
}

export async function updateProfile(req, res) {
  const data = await authService.updateProfile(req.auth.userId, req.validated.body);
  return sendSuccess(res, { data, message: 'Profile updated' });
}

export async function uploadAvatar(req, res) {
  const data = await authService.updateAvatar(req.auth.userId, req.file);
  return sendSuccess(res, { data, message: 'Profile photo updated' });
}

export async function removeAvatar(req, res) {
  const data = await authService.removeAvatar(req.auth.userId);
  return sendSuccess(res, { data, message: 'Profile photo removed' });
}

export async function setupTwoFactor(req, res) {
  const data = await authService.setupTwoFactor(req.auth.userId);
  return sendSuccess(res, { data, message: 'Scan the QR code with your authenticator app' });
}

export async function enableTwoFactor(req, res) {
  await authService.enableTwoFactor(req.auth.userId, req.validated.body);
  return sendSuccess(res, { message: 'Two-factor authentication enabled' });
}

export async function disableTwoFactor(req, res) {
  await authService.disableTwoFactor(req.auth.userId, req.validated.body);
  return sendSuccess(res, { message: 'Two-factor authentication disabled' });
}

export async function listSessions(req, res) {
  const data = await authService.listSessions(req.auth.userId, req.auth.sessionId);
  return sendSuccess(res, { data });
}

export async function revokeSession(req, res) {
  await authService.revokeSession(req.auth.userId, req.validated.params.id);
  return sendSuccess(res, { message: 'Session signed out' });
}

export async function revokeOtherSessions(req, res) {
  await authService.revokeOtherSessions(req.auth.userId, req.auth.sessionId);
  return sendSuccess(res, { message: 'Signed out of all other devices' });
}

export async function loginHistory(req, res) {
  const data = await authService.loginHistory(req.auth.userId);
  return sendSuccess(res, { data });
}
