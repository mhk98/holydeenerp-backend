import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { authLimiter } from '../../middlewares/rateLimit.js';
import { imageUpload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import * as c from './auth.controller.js';
import * as v from './auth.validation.js';

const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Sign-in, sessions, password and two-factor authentication
 * components:
 *   schemas:
 *     SessionUser:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         name: { type: string }
 *         email: { type: string }
 *         companyId: { type: string }
 *         roles: { type: array, items: { type: object } }
 *         permissions: { type: array, items: { type: string }, example: ['users.view', 'sales.create'] }
 *         branches: { type: array, items: { type: object } }
 *         twoFactorEnabled: { type: boolean }
 *     SessionResponse:
 *       type: object
 *       properties:
 *         success: { type: boolean }
 *         message: { type: string }
 *         data:
 *           type: object
 *           properties:
 *             accessToken: { type: string }
 *             user: { $ref: '#/components/schemas/SessionUser' }
 */

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in with email and password
 *     description: |
 *       Sets the refresh token as an httpOnly cookie. When 2FA is enabled the response is
 *       `{ requiresTwoFactor: true, challengeToken }` — complete it with POST /auth/login/2fa.
 *       5 failed attempts lock the account for 15 minutes (HTTP 423).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, example: superadmin@holydeen.com }
 *               password: { type: string, example: Password@123 }
 *     responses:
 *       200: { description: Signed in, content: { application/json: { schema: { $ref: '#/components/schemas/SessionResponse' } } } }
 *       401: { description: Invalid credentials }
 *       403: { description: Account inactive }
 *       423: { description: Account locked }
 */
router.post('/login', authLimiter, validate({ body: v.loginSchema }), c.login);

/**
 * @openapi
 * /auth/login/2fa:
 *   post:
 *     tags: [Auth]
 *     summary: Complete sign-in with a TOTP code
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [challengeToken, code]
 *             properties:
 *               challengeToken: { type: string }
 *               code: { type: string, example: '123456' }
 *     responses:
 *       200: { description: Signed in }
 *       401: { description: Invalid code or expired challenge }
 */
router.post('/login/2fa', authLimiter, validate({ body: v.twoFactorLoginSchema }), c.verifyTwoFactor);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate the refresh-token cookie and get a new access token
 *     responses:
 *       200: { description: New access token and user }
 *       401: { description: Missing, invalid, expired or reused refresh token }
 */
router.post('/refresh', c.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: End the current session and clear the refresh cookie
 *     responses:
 *       200: { description: Signed out }
 */
router.post('/logout', c.logout);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Email a password reset link (always returns 200)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [email], properties: { email: { type: string } } }
 *     responses:
 *       200: { description: Request accepted }
 */
router.post('/forgot-password', authLimiter, validate({ body: v.forgotPasswordSchema }), c.forgotPassword);

/**
 * @openapi
 * /auth/reset-password/{token}:
 *   get:
 *     tags: [Auth]
 *     summary: Check whether a reset link is still valid
 *     parameters:
 *       - { in: path, name: token, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Valid }
 *       400: { description: Invalid or expired }
 */
router.get('/reset-password/:token', validate({ params: v.resetTokenParams }), c.checkResetToken);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Set a new password using a reset token (signs out all sessions)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties: { token: { type: string }, password: { type: string } }
 *     responses:
 *       200: { description: Password reset }
 *       400: { description: Invalid or expired token }
 */
router.post('/reset-password', authLimiter, validate({ body: v.resetPasswordSchema }), c.resetPassword);

// ── Everything below requires a signed-in user ────────────────────────────
router.use(authenticate);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Current user with roles, permissions and branches
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Current user }
 *       401: { description: Not signed in }
 */
router.get('/me', c.me);

/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Change own password (signs out other sessions)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties: { currentPassword: { type: string }, newPassword: { type: string } }
 *     responses:
 *       200: { description: Password changed }
 *       422: { description: Current password wrong or new password invalid }
 */
router.post('/change-password', validate({ body: v.changePasswordSchema }), c.changePassword);

/**
 * @openapi
 * /auth/profile:
 *   patch:
 *     tags: [Auth]
 *     summary: Update own name, phone and language
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, language]
 *             properties: { name: { type: string }, phone: { type: string }, language: { type: string, enum: [en, bn] } }
 *     responses:
 *       200: { description: Updated user }
 */
router.patch('/profile', validate({ body: v.updateProfileSchema }), c.updateProfile);

/**
 * @openapi
 * /auth/profile/avatar:
 *   post:
 *     tags: [Auth]
 *     summary: Upload a profile photo (JPG/PNG/WEBP)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, properties: { avatar: { type: string, format: binary } } }
 *     responses:
 *       200: { description: Updated user }
 *   delete:
 *     tags: [Auth]
 *     summary: Remove the profile photo
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated user }
 */
router.post('/profile/avatar', imageUpload('avatars').single('avatar'), c.uploadAvatar);
router.delete('/profile/avatar', c.removeAvatar);

/**
 * @openapi
 * /auth/2fa/setup:
 *   post:
 *     tags: [Auth]
 *     summary: Start 2FA setup — returns a QR code and the secret for manual entry
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: QR code (data URL) and secret }
 * /auth/2fa/enable:
 *   post:
 *     tags: [Auth]
 *     summary: Confirm 2FA setup with a code from the authenticator app
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [code], properties: { code: { type: string } } }
 *     responses:
 *       200: { description: Enabled }
 * /auth/2fa/disable:
 *   post:
 *     tags: [Auth]
 *     summary: Disable 2FA (requires password and a current code)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password, code]
 *             properties: { password: { type: string }, code: { type: string } }
 *     responses:
 *       200: { description: Disabled }
 */
router.post('/2fa/setup', c.setupTwoFactor);
router.post('/2fa/enable', validate({ body: v.enableTwoFactorSchema }), c.enableTwoFactor);
router.post('/2fa/disable', validate({ body: v.disableTwoFactorSchema }), c.disableTwoFactor);

/**
 * @openapi
 * /auth/sessions:
 *   get:
 *     tags: [Auth]
 *     summary: Active sessions (devices) of the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sessions; `current` marks this device }
 * /auth/sessions/revoke-others:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out every other device
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Done }
 * /auth/sessions/{id}:
 *   delete:
 *     tags: [Auth]
 *     summary: Sign out one session
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Done }
 *       404: { description: Not found }
 * /auth/login-history:
 *   get:
 *     tags: [Auth]
 *     summary: Last 20 sign-in attempts for the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Login history }
 */
router.get('/sessions', c.listSessions);
router.post('/sessions/revoke-others', c.revokeOtherSessions);
router.delete('/sessions/:id', validate({ params: v.sessionParams }), c.revokeSession);
router.get('/login-history', c.loginHistory);

export default router;
