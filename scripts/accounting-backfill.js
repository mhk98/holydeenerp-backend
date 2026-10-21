/**
 * Post the journals missing for documents recorded before accounting existed.
 *   npm run accounting:backfill              every company
 *   npm run accounting:backfill -- HOLYDEEN  one company (by code)
 * Safe to run repeatedly: documents that already have their journal are skipped.
 */
import { closeDatabase } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import { Company } from '../src/models.js';
import { backfillCompany } from '../src/modules/accounting/backfill.service.js';

const code = process.argv[2];
try {
  const companies = await Company.findAll({
    where: code ? { code } : {},
    attributes: ['id', 'code', 'name'],
  });
  if (!companies.length) logger.warn(code ? `No company with code ${code}` : 'No companies');
  for (const company of companies) {
    logger.info(`Backfilling journals for ${company.name} (${company.code})…`);
    const { posted } = await backfillCompany(company.id, {
      onProgress: (step) => logger.info(`  ${step}`),
    });
    logger.info(`Done: ${JSON.stringify(posted)}`);
  }
} catch (err) {
  logger.error(`Backfill failed: ${err.message}`, { stack: err.stack });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
