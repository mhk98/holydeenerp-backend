import { z } from 'zod';

/** Path/body id: numeric string or number → string (BIGINTs are handled as strings). */
export const idSchema = z.coerce
  .string()
  .regex(/^\d+$/, 'Invalid id')
  .refine((v) => v !== '0', 'Invalid id');

export const idParams = z.object({ id: idSchema });

/** Unique list of ids. */
export const idListSchema = z.array(idSchema).transform((ids) => [...new Set(ids)]);
