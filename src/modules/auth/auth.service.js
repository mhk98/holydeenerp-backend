import QRCode from 'qrcode';
import speakeasy from 'speakeasy';
import { Op } from 'sequelize';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendCompanyMail } from '../settings/mail.service.js';
import { Company, LoginHistory, RefreshToken, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../utils/crypto.js';
import { removeImage, saveImage } from '../../utils/storage.js';
import { minutesFromNow } from '../../utils/time.js';
import { assertCanSignIn, loadAccessContext, toSessionUser } from './access.service.js';
import { passwordResetEmail } from './auth.emails.js';
import { fakeVerify, hashPassword, verifyPassword } from './password.js';
import * as tokens from './token.service.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

const findUserWithSecrets = (where) =>
  User.scope('withSecrets').findOne({
    where,
    include: [{ model: Company, as: 'company', attributes: ['id', 'isActive'] }],
  });

function recordAttempt(meta, { user, email, success, reason }) {
  return LoginHistory.create({
    companyId: user?.companyId ?? null,
    userId: user?.id ?? null,
    email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    deviceName: meta.deviceName,
    success,
    failureReason: reason ?? null,
  });
}

function lockedError(user) {
  const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
  return new AppError(`Too many failed attempts. Try again in ${minutes} minute(s).`, 423);
}

const isLocked = (user) => user.lockedUntil && user.lockedUntil.getTime() > Date.now();

/** Count a failed attempt; lock the account when the limit is reached. */
async function registerFailure(user, meta, reason) {
  const attempts = user.failedLoginAttempts + 1;
  if (attempts >= env.AUTH_MAX_FAILED_ATTEMPTS) {
    await user.update({ failedLoginAttempts: 0, lockedUntil: minutesFromNow(env.AUTH_LOCKOUT_MINUTES) });
    await recordAttempt(meta, { user, email: user.email, success: false, reason: 'locked' });
    logger.warn(`Account locked after ${attempts} failed attempts: user ${user.id}`);
    throw lockedError(user);
  }
  await user.update({ failedLoginAttempts: attempts });
  await recordAttempt(meta, { user, email: user.email, success: false, reason });
}

async function completeLogin(user, meta) {
  await user.update({
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
    lastLoginIp: meta.ip,
  });
  const session = await tokens.startSession(user, meta);
  await recordAttempt(meta, { user, email: user.email, success: true });
  const ctx = await loadAccessContext(user.id);
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, user: toSessionUser(ctx) };
}

/**
 * Step 1 of login. Returns a full session, or { requiresTwoFactor, challengeToken }
 * when the user has 2FA enabled.
 */
export async function login({ email, password }, meta) {
  const user = await findUserWithSecrets({ email });

  if (!user) {
    await fakeVerify(password);
    await recordAttempt(meta, { email, success: false, reason: 'unknown_email' });
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (isLocked(user)) {
    await recordAttempt(meta, { user, email, success: false, reason: 'locked' });
    throw lockedError(user);
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    await registerFailure(user, meta, 'invalid_password');
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  try {
    assertCanSignIn(user);
  } catch (err) {
    await recordAttempt(meta, { user, email, success: false, reason: 'inactive' });
    throw err;
  }

  if (user.twoFactorEnabled) {
    return { requiresTwoFactor: true, challengeToken: tokens.signTwoFactorChallenge(user.id) };
  }
  return completeLogin(user, meta);
}

function verifyTotp(encryptedSecret, code) {
  return speakeasy.totp.verify({
    secret: decrypt(encryptedSecret),
    encoding: 'base32',
    token: code,
    window: 1,
  });
}

/** Step 2 of login for 2FA users. Wrong codes count towards the lockout. */
export async function verifyTwoFactorLogin({ challengeToken, code }, meta) {
  const { sub } = tokens.verifyTwoFactorChallenge(challengeToken);
  const user = await findUserWithSecrets({ id: sub });
  if (!user || !user.twoFactorEnabled)
    throw AppError.unauthorized('Verification failed. Please sign in again.');
  if (isLocked(user)) throw lockedError(user);
  assertCanSignIn(user);

  if (!verifyTotp(user.twoFactorSecret, code)) {
    await registerFailure(user, meta, 'invalid_2fa');
    throw AppError.unauthorized('Invalid verification code');
  }
  return completeLogin(user, meta);
}

/** Rotate the refresh token and return a fresh access token + user. */
export async function refresh(rawToken, meta) {
  const { userId, sessionId, refreshToken } = await tokens.rotateRefreshToken(rawToken, meta);
  const ctx = await loadAccessContext(userId);
  if (!ctx) throw AppError.unauthorized('Account no longer exists');
  try {
    assertCanSignIn(ctx.user);
  } catch (err) {
    await tokens.revokeFamily(sessionId, 'inactive');
    throw err;
  }
  return { accessToken: tokens.signAccessToken(ctx.user, sessionId), refreshToken, user: toSessionUser(ctx) };
}

export const logout = (rawToken) => tokens.revokeByRawToken(rawToken);

export const me = (ctx) => toSessionUser(ctx);

/** Change own password; every other session is signed out. */
export async function changePassword(userId, sessionId, { currentPassword, newPassword }) {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'newPassword', message: 'New password must be different from the current one' },
    ]);
  }
  await user.update({
    passwordHash: await hashPassword(newPassword),
    passwordChangedAt: new Date(),
    updatedBy: userId,
  });
  await tokens.revokeAllSessions(userId, { exceptSessionId: sessionId, reason: 'password_changed' });
}

/** Always succeeds from the caller's view so emails cannot be enumerated. */
export async function forgotPassword({ email }) {
  const user = await User.findOne({ where: { email, status: 'active' } });
  if (!user) return;

  const token = randomToken(32);
  await user.update({
    passwordResetTokenHash: sha256(token),
    passwordResetExpiresAt: minutesFromNow(env.PASSWORD_RESET_EXPIRES_MINUTES),
  });

  const mail = passwordResetEmail({ name: user.name, language: user.language, token });
  try {
    await sendCompanyMail(user.companyId, { to: user.email, ...mail });
  } catch (err) {
    logger.error(`Password reset email to user ${user.id} failed: ${err.message}`);
  }
}

async function findUserByResetToken(token) {
  const user = await User.scope('withSecrets').findOne({
    where: { passwordResetTokenHash: sha256(token), passwordResetExpiresAt: { [Op.gt]: new Date() } },
  });
  if (!user) throw AppError.badRequest('This reset link is invalid or has expired');
  return user;
}

export async function checkResetToken(token) {
  const user = await findUserByResetToken(token);
  return { email: user.email };
}

/** Set a new password from a reset link; unlocks the account and signs out all sessions. */
export async function resetPassword({ token, password }) {
  const user = await findUserByResetToken(token);
  await user.update({
    passwordHash: await hashPassword(password),
    passwordChangedAt: new Date(),
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
  });
  await tokens.revokeAllSessions(user.id, { reason: 'password_reset' });
}

export async function updateProfile(userId, data) {
  await User.update({ ...data, updatedBy: userId }, { where: { id: userId } });
  return toSessionUser(await loadAccessContext(userId));
}

export async function updateAvatar(userId, file) {
  if (!file) throw AppError.badRequest('Please choose an image to upload');
  const user = await User.findByPk(userId);
  const previous = user.avatarUrl;
  await user.update({ avatarUrl: await saveImage(file, 'avatars'), updatedBy: userId });
  await removeImage(previous);
  return toSessionUser(await loadAccessContext(userId));
}

export async function removeAvatar(userId) {
  const user = await User.findByPk(userId);
  await removeImage(user.avatarUrl);
  await user.update({ avatarUrl: null, updatedBy: userId });
  return toSessionUser(await loadAccessContext(userId));
}

/** Begin 2FA setup: store a pending secret and return a QR code for the authenticator app. */
export async function setupTwoFactor(userId) {
  const user = await User.findByPk(userId);
  if (user.twoFactorEnabled) throw AppError.conflict('Two-factor authentication is already enabled');

  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${env.APP_NAME} (${user.email})`,
    issuer: env.APP_NAME,
  });
  await user.update({ twoFactorPendingSecret: encrypt(secret.base32) });
  return {
    qrCode: await QRCode.toDataURL(secret.otpauth_url, { margin: 1, width: 240 }),
    secret: secret.base32,
  };
}

export async function enableTwoFactor(userId, { code }) {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user.twoFactorPendingSecret) throw AppError.badRequest('Start two-factor setup first');
  if (!verifyTotp(user.twoFactorPendingSecret, code)) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'code', message: 'Invalid verification code' },
    ]);
  }
  await user.update({
    twoFactorEnabled: true,
    twoFactorSecret: user.twoFactorPendingSecret,
    twoFactorPendingSecret: null,
  });
}

export async function disableTwoFactor(userId, { password, code }) {
  const user = await User.scope('withSecrets').findByPk(userId);
  if (!user.twoFactorEnabled) throw AppError.badRequest('Two-factor authentication is not enabled');
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'password', message: 'Password is incorrect' },
    ]);
  }
  if (!verifyTotp(user.twoFactorSecret, code)) {
    throw AppError.unprocessable('Validation failed', [
      { field: 'code', message: 'Invalid verification code' },
    ]);
  }
  await user.update({ twoFactorEnabled: false, twoFactorSecret: null, twoFactorPendingSecret: null });
}

export const listSessions = (userId, sessionId) => tokens.listSessions(userId, sessionId);

export async function revokeSession(userId, sessionId) {
  const owned = await RefreshToken.count({ where: { userId, familyId: sessionId } });
  if (!owned) throw AppError.notFound('Session not found');
  await tokens.revokeFamily(sessionId, 'revoked');
}

export const revokeOtherSessions = (userId, currentSessionId) =>
  tokens.revokeAllSessions(userId, { exceptSessionId: currentSessionId, reason: 'revoked' });

export async function loginHistory(userId) {
  return LoginHistory.findAll({
    where: { userId },
    attributes: ['id', 'ip', 'deviceName', 'success', 'failureReason', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit: 20,
  });
}
