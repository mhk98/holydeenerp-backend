import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Public image storage. Uses Cloudinary when CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET are set,
 * otherwise the local `<UPLOAD_DIR>` served at /uploads. Stored values are what the web app renders:
 * a full https URL (Cloudinary) or a `/uploads/<folder>/<file>` path (local).
 */
export const useCloudinary = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

if (useCloudinary) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const uploadsRoot = () => path.resolve(env.ROOT_DIR, env.UPLOAD_DIR);
const uniqueName = () => `${Date.now()}-${crypto.randomUUID()}`;

function uploadToCloudinary(file, folder) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: `${env.CLOUDINARY_FOLDER}/${folder}`,
          public_id: uniqueName(),
          resource_type: 'image',
          overwrite: false,
        },
        (err, result) => (err ? reject(err) : resolve(result.secure_url)),
      )
      .end(file.buffer);
  });
}

/** Save one image (multer memory file) into `folder`; returns the URL/path to store. */
export async function saveImage(file, folder) {
  if (useCloudinary) return uploadToCloudinary(file, folder);
  const name = `${uniqueName()}${EXTENSIONS[file.mimetype] ?? ''}`;
  const dir = path.resolve(uploadsRoot(), folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), file.buffer);
  return `/uploads/${folder}/${name}`;
}

export const saveImages = (files, folder) => Promise.all(files.map((f) => saveImage(f, folder)));

/** `<cloud>/image/upload/v123/holydeen/products/abc.jpg` → `holydeen/products/abc` */
function cloudinaryPublicId(url) {
  const marker = `/${env.CLOUDINARY_CLOUD_NAME}/image/upload/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  return url
    .slice(at + marker.length)
    .replace(/^v\d+\//, '')
    .replace(/\.[a-z0-9]+$/i, '');
}

/** Delete a stored image. Never throws — a leftover file must not fail the request. */
export async function removeImage(stored) {
  if (!stored) return;
  if (stored.startsWith('/uploads/')) {
    const file = path.resolve(uploadsRoot(), stored.slice('/uploads/'.length));
    if (file.startsWith(uploadsRoot())) await fs.unlink(file).catch(() => {});
    return;
  }
  if (!useCloudinary || !/^https?:\/\//.test(stored)) return;
  const publicId = cloudinaryPublicId(stored);
  if (!publicId) return;
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch((err) => {
    logger.warn(`Cloudinary delete failed for ${publicId}: ${err.message}`);
  });
}
