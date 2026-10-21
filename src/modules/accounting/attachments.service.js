import fs from 'node:fs/promises';
import path from 'node:path';
import { Attachment, Expense, Voucher } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { assertBranchAccess } from '../inventory/inventory.common.js';
import { ATTACHMENT_DIR } from '../../middlewares/upload.js';

/**
 * Files attached to accounting documents (bills, receipts, statements). They are kept outside the
 * public uploads folder and served only through GET /accounting/attachments/:id (signed-in users with
 * accounting.view who can see the document's branch).
 */

const OWNERS = { expense: Expense, voucher: Voucher };
const MAX_PER_DOCUMENT = 10;

async function findOwner(ctx, entityType, entityId) {
  const model = OWNERS[entityType];
  if (!model) throw AppError.badRequest('Files cannot be attached to this document');
  const owner = await model.findOne({ where: { id: entityId, companyId: ctx.auth.companyId } });
  if (!owner) throw AppError.notFound('Document not found');
  if (owner.branchId) assertBranchAccess(ctx, owner.branchId);
  return owner;
}

const removeFiles = (files) =>
  Promise.all((files ?? []).map((f) => fs.rm(f.path, { force: true }).catch(() => {})));

/** Store uploaded files (multer already wrote them to ATTACHMENT_DIR) against a document. */
export async function addAttachments(ctx, entityType, entityId, files) {
  try {
    await findOwner(ctx, entityType, entityId);
    if (!files?.length)
      throw AppError.unprocessable('Choose a file', [{ field: 'files', message: 'Choose a file' }]);
    const existing = await Attachment.count({
      where: { companyId: ctx.auth.companyId, entityType, entityId },
    });
    if (existing + files.length > MAX_PER_DOCUMENT)
      throw AppError.unprocessable(`At most ${MAX_PER_DOCUMENT} files per document`);
  } catch (err) {
    await removeFiles(files);
    throw err;
  }
  const rows = await Attachment.bulkCreate(
    files.map((f) => ({
      companyId: ctx.auth.companyId,
      entityType,
      entityId,
      originalName: f.originalname.slice(0, 255),
      storedName: f.filename,
      mimeType: f.mimetype,
      size: f.size,
      createdBy: ctx.auth.userId,
      updatedBy: ctx.auth.userId,
    })),
  );
  return rows.map((r) => r.toJSON());
}

async function findAttachment(ctx, id) {
  const row = await Attachment.findOne({ where: { id, companyId: ctx.auth.companyId } });
  if (!row) throw AppError.notFound('File not found');
  await findOwner(ctx, row.entityType, row.entityId);
  return row;
}

/** Where to read the file from, and how to name it for the browser. */
export async function attachmentFile(ctx, id) {
  const row = await findAttachment(ctx, id);
  return {
    path: path.join(ATTACHMENT_DIR, path.basename(row.storedName)),
    originalName: row.originalName,
    mimeType: row.mimeType,
  };
}

export async function removeAttachment(ctx, id) {
  const row = await findAttachment(ctx, id);
  await row.update({ updatedBy: ctx.auth.userId });
  await row.destroy();
  await fs.rm(path.join(ATTACHMENT_DIR, path.basename(row.storedName)), { force: true }).catch(() => {});
}
