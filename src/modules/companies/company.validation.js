import { z } from 'zod';
import { email, name, optionalText, phone } from '../settings/settings.schemas.js';

const taxId = optionalText(50).refine(
  (v) => !v || /^[0-9A-Za-z-]+$/.test(v),
  'Use numbers, letters and dashes',
);

export const updateCompanySchema = z
  .object({
    name: name(150),
    legalName: optionalText(200),
    email,
    phone,
    website: optionalText(191).refine(
      (v) => !v || /^https?:\/\/\S+$/.test(v),
      'Start with http:// or https://',
    ),
    address: optionalText(1000),
    binNo: taxId,
    tinNo: taxId,
    vatRegNo: taxId,
  })
  .partial();
