// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

/**
 * What `exchange()` reports about each request it makes, without knowing who is listening.
 *
 * `ivanti/` knows nothing about MCP, usage lines or metrics, so it cannot import them. It reports
 * to this seam instead, and the composition root (`observe-ivanti.ts`) says where the reports go.
 * Until it does, they go nowhere — a library use of `ivanti/` counts nothing.
 */
export interface RequestObserver {
  /** A request is about to be sent (counted when sent: a timeout cost as much as a reply). */
  sent: () => void;
  /** A request ended — with an HTTP status, or 0 when nothing answered. */
  answered: (method: string, status: number, ms: number) => void;
  /** A request was refused a slot by the limiter and never sent. */
  notSent: () => void;
}

const SILENT: RequestObserver = { sent: () => undefined, answered: () => undefined, notSent: () => undefined };

let observer: RequestObserver = SILENT;

/** Installs the observer; `undefined` restores the silent default. */
export function setRequestObserver(next: RequestObserver | undefined): void {
  observer = next ?? SILENT;
}

export const countIvantiRequest = (): void => {
  observer.sent();
};

export const recordIvantiRequest = (method: string, status: number, ms: number): void => {
  observer.answered(method, status, ms);
};

export const recordIvantiRequestNotSent = (): void => {
  observer.notSent();
};
