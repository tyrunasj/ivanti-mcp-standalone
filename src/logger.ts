// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (line: string) => void;

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Logs structured JSON to stderr.
 *
 * stderr is not a stylistic choice: under the stdio transport, stdout carries the
 * JSON-RPC stream. Anything written there corrupts the protocol.
 */
export function createLogger(
  level: LogLevel,
  sink: LogSink = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const log = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[entryLevel] < RANK[level]) return;
    sink(JSON.stringify({ level: entryLevel, message, ...fields }));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  };
}
