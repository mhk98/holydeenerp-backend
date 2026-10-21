import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { env } from './env.js';

const { combine, timestamp, errors, json, colorize, printf, splat } = winston.format;

const logDir = path.resolve(env.ROOT_DIR, env.LOG_DIR);

const consoleFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level}: ${stack || message}${rest}`;
});

const transports = [];

if (!env.isTest) {
  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new DailyRotateFile({
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
    }),
  );
}

transports.push(
  new winston.transports.Console({
    silent: env.isTest,
    format: env.isProd ? json() : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), consoleFormat),
  }),
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: combine(timestamp(), errors({ stack: true }), splat(), json()),
  transports,
  exitOnError: false,
});

/** Stream for morgan → winston (http level). */
export const morganStream = {
  write: (message) => logger.http(message.trim()),
};
