import { z } from 'zod';

const permissionKeys = z
  .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/, 'Invalid permission key'))
  .transform((keys) => [...new Set(keys)]);

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  description: z
    .string()
    .trim()
    .max(255)
    .nullish()
    .transform((v) => v || null),
  permissionKeys: permissionKeys.default([]),
});

export const updateRoleSchema = createRoleSchema.partial();

export const setPermissionsSchema = z.object({ permissionKeys });
