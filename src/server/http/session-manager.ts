// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Logger } from '../../logger.js';
import { SessionStore } from './session-store.js';

export interface ClosableSession {
  close: () => void | Promise<void>;
}

export interface SessionManagerOptions {
  maxSessions: number;
  idleTtlMs: number;
  logger: Logger;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Session lifecycle policy: admission, expiry and shutdown.
 *
 * `SessionStore` is the data structure — a bounded map with an idle timeout. This is the
 * policy around it: when a new session is admitted, when expiry runs, and what gets logged.
 * The split keeps the store generic and reusable while this layer knows about MCP sessions.
 */
export class SessionManager<T extends ClosableSession> {
  private readonly store: SessionStore<T>;

  constructor(private readonly options: SessionManagerOptions) {
    this.store = new SessionStore<T>({
      maxSessions: options.maxSessions,
      idleTtlMs: options.idleTtlMs,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  get size(): number {
    return this.store.size;
  }

  get(id: string): T | undefined {
    return this.store.get(id);
  }

  register(id: string, session: T): boolean {
    if (!this.store.set(id, session)) {
      this.options.logger.warn('session cap reached, dropping new session', { sessionId: id });
      void session.close();
      return false;
    }
    this.options.logger.info('session opened', { sessionId: id, sessions: this.store.size });
    return true;
  }

  unregister(id: string): void {
    this.store.delete(id);
    this.options.logger.info('session closed', { sessionId: id, sessions: this.store.size });
  }

  /**
   * Whether a new session can be admitted, sweeping first.
   *
   * The sweep matters: expiry otherwise runs only on a timer, so an expired-but-unswept
   * session still occupies a slot and a client would be turned away for sessions already dead.
   */
  admit(): boolean {
    if (this.store.size < this.options.maxSessions) return true;

    this.expire('idle');

    if (this.store.size >= this.options.maxSessions) {
      this.options.logger.warn('refusing new session, cap reached', {
        cap: this.options.maxSessions,
      });
      return false;
    }
    return true;
  }

  private expire(reason: string): void {
    for (const { id, value } of this.store.sweep()) {
      this.options.logger.debug('closing session', { sessionId: id, reason });
      void value.close();
    }
  }

  /** Starts periodic expiry; returns the function that stops it. */
  startSweeping(intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.expire('idle');
    }, intervalMs);
    timer.unref();

    return (): void => {
      clearInterval(timer);
    };
  }

  closeAll(): void {
    for (const { id, value } of this.store.drain()) {
      this.options.logger.debug('closing session', { sessionId: id, reason: 'shutdown' });
      void value.close();
    }
  }
}
