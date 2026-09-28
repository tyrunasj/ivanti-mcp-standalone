// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { AsyncLocalStorage } from 'node:async_hooks';

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

const context = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Stamps every line logged while `run` executes — including the Ivanti requests it makes — with
 * `fields`.
 *
 * Under HTTP several conversations run at once, and an `ivanti request` line that does not say
 * which tool call caused it cannot be joined to anything. Threading a request id through every
 * `deps` would touch every layer; the async context reaches them all without that.
 */
export function withLogContext<T>(fields: Record<string, unknown>, run: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, run);
}

/**
 * What an `Error` becomes in a log line.
 *
 * `JSON.stringify` writes a plain `Error` as `{}` — `message` and `stack` are not enumerable — so
 * an error passed as a field used to log as nothing at all. An error that knows better defines
 * `toJSON`, which `JSON.stringify` calls before this ever sees it.
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause === undefined ? {} : { cause: value.cause }),
    };
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Logs structured JSON to stderr.
 *
 * stderr is not a stylistic choice: under the stdio transport, stdout carries the JSON-RPC stream.
 * Anything written there corrupts the protocol.
 */
export function createLogger(
  level: LogLevel,
  sink: LogSink = (line) => process.stderr.write(`${line}\n`),
  now: () => Date = () => new Date(),
): Logger {
  const log = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[entryLevel] < RANK[level]) return;

    // Spread twice: first so these lead the line, last so a field called `message` or `level`
    // cannot overwrite them.
    const head = { time: now().toISOString(), level: entryLevel, message };
    let line: string;
    try {
      line = JSON.stringify({ ...head, ...context.getStore(), ...fields, ...head }, replacer);
    } catch {
      // A circular field. The line still says what happened; a logger that throws would fail the
      // call it was only meant to describe.
      line = JSON.stringify({ ...head, logError: 'fields could not be serialised' });
    }
    sink(line);
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  };
}
