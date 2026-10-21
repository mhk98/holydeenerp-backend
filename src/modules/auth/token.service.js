import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { RefreshToken } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { durationToMs } from '../../utils/time.js';

export const REFRESH_COOKIE = 'hd_rt';
const REFRESH_TTL_MS = durationToMs(env.JWT_REFRESH_EXPIRES_IN);
/** A just-rotated token presented again within this window (parallel tabs) is not treated as theft. */
const ROTATION_GRACE_MS = 30_000;

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/v1/auth',
    maxAge: REFRESH_TTL_MS,
  };
}

/** Short-lived access token. `sid` is the session (refresh family) id. */
export function signAccessToken(user, sessionId) {
  return jwt.sign(
    { sub: String(user.id), cid: String(user.companyId), sid: sessionId },
    env.JWT_ACCESS_SECRET,
    {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    },
  );
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (payload.typ) throw new Error('Wrong token type');
    return payload;
  } catch {
    throw AppError.unauthorized('Invalid or expired access token');
  }
}

/** Short-lived token proving the password step succeeded; exchanged with a TOTP code. */
export function signTwoFactorChallenge(userId) {
  return jwt.sign({ sub: String(userId), typ: '2fa' }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
}

export function verifyTwoFactorChallenge(token) {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (payload.typ !== '2fa') throw new Error('Wrong token type');
    return payload;
  } catch {
    throw AppError.unauthorized('Verification session expired. Please sign in again.');
  }
}

async function createRefreshToken(userId, familyId, meta, transaction) {
  const raw = randomToken();
  await RefreshToken.create(
    {
      userId,
      familyId,
      tokenHash: sha256(raw),
      ip: meta.ip,
      userAgent: meta.userAgent,
      deviceName: meta.deviceName,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      lastUsedAt: new Date(),
    },
    { transaction },
  );
  return raw;
}

/** Start a new session after a successful login. */
export async function startSession(user, meta) {
  const sessionId = crypto.randomUUID();
  const refreshToken = await createRefreshToken(user.id, sessionId, meta);
  return { sessionId, refreshToken, accessToken: signAccessToken(user, sessionId) };
}

/**
 * Rotate a refresh token: revoke the presented one, issue a new one in the same family.
 * Presenting an already-rotated token (outside the grace window) means it was stolen,
 * so the whole family is revoked.
 */
export async function rotateRefreshToken(raw, meta) {
  if (!raw) throw AppError.unauthorized('No refresh token');
  const current = await RefreshToken.findOne({ where: { tokenHash: sha256(raw) } });
  if (!current) throw AppError.unauthorized('Invalid refresh token');

  if (current.revokedAt) {
    const benignRace =
      current.revokedReason === 'rotated' && Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS;
    if (!benignRace) {
      await revokeFamily(current.familyId, 'reuse_detected');
      logger.warn(
        `Refresh token reuse detected for user ${current.userId}; session ${current.familyId} revoked`,
      );
      throw AppError.unauthorized('Session expired. Please sign in again.');
    }
    const familyAlive = await RefreshToken.count({ where: { familyId: current.familyId, revokedAt: null } });
    if (!familyAlive) throw AppError.unauthorized('Session expired. Please sign in again.');
  }

  if (current.expiresAt.getTime() <= Date.now()) {
    await current.update({ revokedAt: new Date(), revokedReason: 'expired' });
    throw AppError.unauthorized('Session expired. Please sign in again.');
  }

  if (!current.revokedAt) await current.update({ revokedAt: new Date(), revokedReason: 'rotated' });
  const refreshToken = await createRefreshToken(current.userId, current.familyId, meta);
  return { userId: current.userId, sessionId: current.familyId, refreshToken };
}

export async function revokeFamily(familyId, reason = 'logout') {
  await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: reason },
    { where: { familyId, revokedAt: null } },
  );
}

/** Revoke every session of a user, optionally keeping one. */
export async function revokeAllSessions(userId, { exceptSessionId, reason = 'revoked' } = {}) {
  const where = { userId, revokedAt: null };
  if (exceptSessionId) where.familyId = { [Op.ne]: exceptSessionId };
  await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where });
}

export async function revokeByRawToken(raw) {
  if (!raw) return;
  const current = await RefreshToken.findOne({ where: { tokenHash: sha256(raw) } });
  if (current) await revokeFamily(current.familyId, 'logout');
}

/** True while the session has at least one live (unrevoked, unexpired) token. */
export async function isSessionActive(sessionId) {
  const count = await RefreshToken.count({
    where: { familyId: sessionId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
  });
  return count > 0;
}

/** Active sessions = live families, newest token per family. */
export async function listSessions(userId, currentSessionId) {
  const rows = await RefreshToken.findAll({
    where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    order: [['createdAt', 'DESC']],
  });
  const seen = new Set();
  return rows
    .filter((r) => !seen.has(r.familyId) && seen.add(r.familyId))
    .map((r) => ({
      id: r.familyId,
      deviceName: r.deviceName,
      ip: r.ip,
      lastUsedAt: r.lastUsedAt ?? r.createdAt,
      expiresAt: r.expiresAt,
      current: r.familyId === currentSessionId,
    }));
}
