import bcrypt from 'bcrypt';
import { z } from 'zod';
import { env } from '../../config/env.js';

/** Password policy shared by user creation, change and reset. */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_SALT_ROUNDS);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);
export const fakeVerify = (plain) => bcrypt.compare(plain, DUMMY_HASH);
