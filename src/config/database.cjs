// sequelize-cli configuration (CommonJS — the CLI loads it with require()).
// Runtime connection lives in ./db.js; both read the same .env values.
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const base = {
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'holydeen_erp',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  dialect: 'mysql',
  timezone: process.env.DB_TIMEZONE || '+06:00',
  logging: false,
  dialectOptions: { decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true },
  define: {
    underscored: true,
    charset: 'utf8mb4',
    collate: 'utf8mb4_unicode_ci',
  },
  migrationStorageTableName: 'sequelize_meta',
  seederStorage: 'sequelize',
  seederStorageTableName: 'sequelize_data',
};

module.exports = {
  development: base,
  // Mirrors env.js: TEST_ALLOW_MAIN_DB=true lets tests use DB_NAME when DB_NAME_TEST is empty.
  test: {
    ...base,
    database:
      process.env.DB_NAME_TEST || (process.env.TEST_ALLOW_MAIN_DB === 'true' ? base.database : undefined),
  },
  production: base,
};
