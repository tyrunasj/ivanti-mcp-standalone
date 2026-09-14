// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { IvantiSession } from '../session/asmx-session.js';
import type { IvantiTransport } from '../http/transport.js';
import type { Logger } from '../../logger.js';

/**
 * The service catalog: what a person may request.
 *
 * Two sources, and the difference matters. `/api/rest/Template/<person>/_All_` returns the whole
 * catalog — 132 offerings and **144 KB** on a stock tenant, most of it a `strConfigOptions` blob
 * describing how the form renders. `ServiceCatalog.asmx` can return only the top-level view, which
 * REST cannot express, but it needs a session.
 *
 * Neither is asked to search. The catalog service takes a `searchString` and, measured against
 * the full list, answers a strict **subset** of a plain name-and-description match — it appears to
 * match whole words, so 'phone' misses 'New Smartphone Request'. Delegating the search would
 * quietly hide offerings from the person asking, so it stays local.
 */

/** An offering, trimmed to what a caller can act on. */
export interface Offering {
  /** What `submit_service_request` needs. NOT the same id as `templateId`. */
  subscriptionId: string;
  /** What `get_service_request_parameters` needs. */
  templateId: string;
  name: string;
  description?: string;
}

export interface OfferingsResult {
  offerings: Offering[];
  /** `catalog` is the top-level view; `rest` is the whole list. */
  servedBy: 'catalog' | 'rest';
  /** Set when a top-level view was asked for and could not be served. */
  note?: string;
}

interface RawOffering {
  strSubscriptionId?: unknown;
  strRecId?: unknown;
  strName?: unknown;
  strDescription?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Keeps four fields of twenty.
 *
 * `strConfigOptions` alone is a nested JSON document per offering describing column counts and
 * price display; passing the raw list through would spend a context window on rendering hints.
 */
function toOffering(raw: RawOffering): Offering | undefined {
  const subscriptionId = text(raw.strSubscriptionId);
  const templateId = text(raw.strRecId);
  const name = text(raw.strName);
  // An offering with no subscription id cannot be submitted, so it is not an offering.
  if (subscriptionId === undefined || templateId === undefined || name === undefined) {
    return undefined;
  }
  const description = text(raw.strDescription);
  return { subscriptionId, templateId, name, ...(description === undefined ? {} : { description }) };
}

export interface OfferingsRequest {
  transport: IvantiTransport;
  session: IvantiSession;
  logger: Logger;
  /** The person the catalog is for — their RecId. */
  personRecId: string;
  topLevelOnly: boolean;
  /** Case-insensitive substring over name and description, applied here. */
  search?: string;
}

export async function listOfferings(request: OfferingsRequest): Promise<OfferingsResult> {
  const { transport, session, logger, personRecId } = request;
  let servedBy: OfferingsResult['servedBy'] = 'rest';
  let raw: RawOffering[] | undefined;
  let note: string | undefined;

  if (request.topLevelOnly) {
    try {
      raw =
        (await session.call<RawOffering[] | null>(
          'ServiceCatalog/services/ServiceCatalog.asmx',
          'GetCategoryTemplatesForUser',
          { categoryid: '_Top_', searchString: '', userRecId: personRecId },
        )) ?? [];
      servedBy = 'catalog';
    } catch (error: unknown) {
      // A role without the catalog service still gets the whole list, and is told that the
      // narrowing did not happen rather than being handed a longer list that looks like the
      // short one.
      logger.debug('service catalog unavailable', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      note = 'The top-level view needs the catalog service, which this credential cannot reach — this is the whole catalog.';
    }
  }

  if (raw === undefined) {
    const answer = await transport.request<RawOffering[] | { value?: RawOffering[] }>(
      transport.routes.rest(`Template/${encodeURIComponent(personRecId)}/_All_`),
    );
    // 204 is a real answer: this person has no offerings available to them.
    raw = answer === undefined ? [] : Array.isArray(answer) ? answer : (answer.value ?? []);
  }

  let offerings = raw.flatMap((entry) => {
    const offering = toOffering(entry);
    return offering === undefined ? [] : [offering];
  });

  const search = request.search?.trim().toLowerCase();
  if (search !== undefined && search !== '') {
    offerings = offerings.filter(
      (offering) =>
        offering.name.toLowerCase().includes(search) ||
        (offering.description?.toLowerCase().includes(search) ?? false),
    );
  }

  offerings.sort((a, b) => a.name.localeCompare(b.name));

  return { offerings, servedBy, ...(note === undefined ? {} : { note }) };
}
