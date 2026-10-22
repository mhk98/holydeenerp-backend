import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/**
 * Image upload kept in memory; the service stores it with `saveImage()` / `saveImages()`
 * (src/utils/storage.js — Cloudinary or the local uploads folder).
 * Usage: router.post('/avatar', imageUpload().single('avatar'), controller)
 * Several files: imageUpload({ maxFiles: 8 }).array('images', 8)
 */
export function imageUpload({ maxFiles = 1 } = {}) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: maxFiles },
    fileFilter: (req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
      return cb(AppError.badRequest('Only JPG, PNG or WEBP images are allowed'));
    },
  });
}

const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

/** Single .xlsx file kept in memory (imports). Field name: "file". */
export const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (XLSX_TYPES.has(file.mimetype) && /\.xlsx$/i.test(file.originalname)) return cb(null, true);
    return cb(AppError.badRequest('Upload an Excel .xlsx file'));
  },
}).single('file');

/**
 * Private files (accounting attachments): stored outside the public uploads folder and served only
 * through an authenticated route. Field name: "files" (up to 10).
 */
export const ATTACHMENT_DIR = path.resolve(env.ROOT_DIR, 'storage', 'attachments');
const ATTACHMENT_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };

export const attachmentUpload = (req, res, next) => {
  fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: ATTACHMENT_DIR,
      filename: (r, file, cb) =>
        cb(null, `${Date.now()}-${crypto.randomUUID()}${ATTACHMENT_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: Math.max(env.MAX_UPLOAD_MB, 5) * 1024 * 1024, files: 10 },
    fileFilter: (r, file, cb) => {
      if (ATTACHMENT_TYPES[file.mimetype]) return cb(null, true);
      return cb(AppError.badRequest('Only PDF, JPG, PNG or WEBP files are allowed'));
    },
  }).array('files', 10)(req, res, next);
};

/** Bank statement (.csv or .xlsx) kept in memory. Field name: "file". */
export const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.(csv|xlsx)$/i.test(file.originalname)) return cb(null, true);
    return cb(AppError.badRequest('Upload the statement as a .csv or .xlsx file'));
  },
}).single('file');
