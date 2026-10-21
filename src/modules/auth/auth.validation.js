import { z } from 'zod';
import { passwordSchema } from './password.js';

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(191);
const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const loginSchema = z.object({
  email,
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(200),
});

export const twoFactorLoginSchema = z.object({
  challengeToken: z.string().min(1),
  code: totpCode,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email });

export const resetTokenParams = z.object({ token: z.string().min(20).max(100) });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(100),
  password: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(150),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[0-9+\-\s()]*$/, 'Enter a valid phone number')
    .optional()
    .transform((v) => v || null),
  language: z.enum(['en', 'bn']),
});

export const enableTwoFactorSchema = z.object({ code: totpCode });

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1, 'Password is required'),
  code: totpCode,
});

export const sessionParams = z.object({ id: z.string().uuid() });
