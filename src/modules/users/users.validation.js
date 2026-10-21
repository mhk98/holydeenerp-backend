import { z } from 'zod';
import { idListSchema, idSchema } from '../../utils/validation.js';
import { passwordSchema } from '../auth/password.js';

const base = {
  name: z.string().trim().min(2, 'Name is required').max(150),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(191),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[0-9+\-\s()]*$/, 'Enter a valid phone number')
    .nullish()
    .transform((v) => v || null),
  status: z.enum(['active', 'inactive']).default('active'),
  language: z.enum(['en', 'bn']).default('en'),
  roleIds: idListSchema.refine((ids) => ids.length > 0, 'Assign at least one role'),
  branchIds: idListSchema.refine((ids) => ids.length > 0, 'Assign at least one branch'),
  defaultBranchId: idSchema.nullish(),
};

const defaultBranchInList = (data) =>
  !data.defaultBranchId || !data.branchIds || data.branchIds.includes(data.defaultBranchId);
const defaultBranchIssue = {
  message: 'Default branch must be one of the assigned branches',
  path: ['defaultBranchId'],
};

export const createUserSchema = z
  .object({ ...base, password: passwordSchema })
  .refine(defaultBranchInList, defaultBranchIssue);

export const updateUserSchema = z
  .object({
    ...base,
    status: base.status.optional(),
    language: base.language.optional(),
    password: passwordSchema.optional().or(z.literal('').transform(() => undefined)),
  })
  .partial()
  .refine(defaultBranchInList, defaultBranchIssue);

export const updateStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });

export const listUsersQuery = z
  .object({
    roleId: idSchema.optional(),
    branchId: idSchema.optional(),
  })
  .passthrough();
