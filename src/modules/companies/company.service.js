import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { Company } from '../../models.js';
import { AppError } from '../../utils/AppError.js';

const FIELDS = [
  'id',
  'name',
  'legalName',
  'code',
  'email',
  'phone',
  'website',
  'address',
  'binNo',
  'tinNo',
  'vatRegNo',
  'logoUrl',
  'timezone',
  'currency',
  'updatedAt',
];

const serialize = (c) => ({ ...Object.fromEntries(FIELDS.map((f) => [f, c[f] ?? null])), id: String(c.id) });

async function load(ctx) {
  const company = await Company.findByPk(ctx.auth.companyId);
  if (!company) throw AppError.notFound('Company not found');
  return company;
}

export async function getCompany(ctx) {
  return serialize(await load(ctx));
}

export async function updateCompany(ctx, data) {
  const company = await load(ctx);
  await company.update({ ...data, updatedBy: ctx.auth.userId });
  return serialize(company);
}

async function removeFile(publicUrl) {
  if (!publicUrl?.startsWith('/uploads/')) return;
  const root = path.resolve(env.ROOT_DIR, env.UPLOAD_DIR);
  const file = path.resolve(root, publicUrl.slice('/uploads/'.length));
  if (file.startsWith(root)) await fs.unlink(file).catch(() => {});
}

export async function updateLogo(ctx, file) {
  if (!file) throw AppError.badRequest('Please choose an image to upload');
  const company = await load(ctx);
  const previous = company.logoUrl;
  await company.update({ logoUrl: `/uploads/logos/${file.filename}`, updatedBy: ctx.auth.userId });
  await removeFile(previous);
  return serialize(company);
}

export async function removeLogo(ctx) {
  const company = await load(ctx);
  await removeFile(company.logoUrl);
  await company.update({ logoUrl: null, updatedBy: ctx.auth.userId });
  return serialize(company);
}
