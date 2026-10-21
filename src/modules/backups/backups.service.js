import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Backup, User } from '../../models.js';
import { AppError } from '../../utils/AppError.js';
import { parseListQuery } from '../../utils/pagination.js';

const BATCH_SIZE = 1000;

export const backupDir = () => path.resolve(env.ROOT_DIR, env.BACKUP_DIR);

const filePath = (fileName) => path.join(backupDir(), path.basename(fileName));

const creator = { model: User, as: 'creator', attributes: ['id', 'name'] };

/** API shape: the row plus whether its file is still on disk. */
function present(row) {
  return { ...row.toJSON(), fileExists: fs.existsSync(filePath(row.fileName)) };
}

export async function listBackups(query) {
  const { page, limit, offset, order, where } = parseListQuery(query, {
    sortable: ['createdAt', 'sizeBytes'],
    filterable: ['type', 'status'],
  });
  const { rows, count } = await Backup.findAndCountAll({ where, order, limit, offset, include: [creator] });
  return { rows: rows.map(present), count, page, limit };
}

async function findBackup(id) {
  const row = await Backup.findByPk(id, { include: [creator] });
  if (!row) throw AppError.notFound('Backup not found');
  return row;
}

export async function backupFile(id) {
  const row = await findBackup(id);
  const file = filePath(row.fileName);
  if (row.status !== 'completed' || !fs.existsSync(file)) throw AppError.notFound('Backup file not found');
  return { file, fileName: row.fileName };
}

export async function deleteBackup(id) {
  const row = await findBackup(id);
  await fs.promises.rm(filePath(row.fileName), { force: true });
  await row.destroy();
}

/**
 * Dump the whole database to `<BACKUP_DIR>/<file>.sql.gz` in plain JS (no mysqldump binary,
 * so it works on shared hosting). Generated columns are left out of INSERTs because MySQL
 * rejects explicit values for them.
 */
export async function createBackup({ type, userId = null }) {
  await fs.promises.mkdir(backupDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const fileName = `${env.DB_DATABASE}-${stamp}-${type}-${Math.random().toString(36).slice(2, 6)}.sql.gz`;
  const row = await Backup.create({ fileName, type, status: 'running', createdBy: userId });

  try {
    const { tablesCount, rowsCount } = await dumpDatabase(filePath(fileName));
    const { size } = await fs.promises.stat(filePath(fileName));
    await row.update({
      status: 'completed',
      tablesCount,
      rowsCount,
      sizeBytes: size,
      completedAt: new Date(),
    });
  } catch (err) {
    logger.error(`Backup ${fileName} failed: ${err.message}`);
    await fs.promises.rm(filePath(fileName), { force: true });
    await row.update({ status: 'failed', error: err.message.slice(0, 1000), completedAt: new Date() });
    throw AppError.unprocessable(`Backup failed: ${err.message}`);
  }
  return present(await findBackup(row.id));
}

/** Keep only the newest `retention` scheduled backups; manual ones are never pruned. */
export async function pruneScheduled(retention) {
  const old = await Backup.findAll({
    where: { type: 'scheduled' },
    order: [['createdAt', 'DESC']],
    offset: retention,
  });
  for (const row of old) {
    await fs.promises.rm(filePath(row.fileName), { force: true });
    await row.destroy();
  }
  return old.length;
}

async function dumpDatabase(file) {
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    charset: 'utf8mb4',
    // Keep values exactly as stored: no Date/float/JSON conversions on the way out.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    typeCast: (field, next) => (field.type === 'JSON' ? field.string() : next()),
  });

  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(file);
  gzip.pipe(out);
  const write = async (text) => {
    if (!gzip.write(text)) await once(gzip, 'drain');
  };

  let tablesCount = 0;
  let rowsCount = 0;
  try {
    await conn.query("SET time_zone = '+00:00'");
    await write(
      `-- ${env.APP_NAME} database backup\n-- Database: ${env.DB_DATABASE}\n-- Created: ${new Date().toISOString()}\n\n` +
        "SET NAMES utf8mb4;\nSET time_zone = '+00:00';\nSET FOREIGN_KEY_CHECKS = 0;\n" +
        "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n",
    );

    const [tables] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    for (const t of tables) {
      const table = Object.values(t)[0];
      const id = conn.escapeId(table);
      const [[create]] = await conn.query(`SHOW CREATE TABLE ${id}`);
      await write(`-- Table ${id}\nDROP TABLE IF EXISTS ${id};\n${create['Create Table']};\n\n`);

      const [cols] = await conn.query(
        `SELECT COLUMN_NAME AS name, COLUMN_KEY AS colKey FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%'
         ORDER BY ORDINAL_POSITION`,
        [table],
      );
      const columns = cols.map((c) => c.name);
      const columnList = columns.map((c) => conn.escapeId(c)).join(', ');
      const pk = cols.filter((c) => c.colKey === 'PRI').map((c) => conn.escapeId(c.name));
      const orderBy = pk.length ? ` ORDER BY ${pk.join(', ')}` : '';

      for (let offset = 0; ; offset += BATCH_SIZE) {
        const [rows] = await conn.query(
          `SELECT ${columnList} FROM ${id}${orderBy} LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
        );
        if (!rows.length) break;
        const values = rows.map((r) => `(${columns.map((c) => conn.escape(r[c])).join(', ')})`).join(',\n');
        await write(`INSERT INTO ${id} (${columnList}) VALUES\n${values};\n`);
        rowsCount += rows.length;
        if (rows.length < BATCH_SIZE) break;
      }
      await write('\n');
      tablesCount += 1;
    }

    await write('SET FOREIGN_KEY_CHECKS = 1;\n');
    gzip.end();
    await once(out, 'finish');
  } catch (err) {
    gzip.destroy();
    out.destroy();
    throw err;
  } finally {
    await conn.end().catch(() => {});
  }
  return { tablesCount, rowsCount };
}
