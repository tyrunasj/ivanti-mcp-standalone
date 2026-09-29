// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import type { Config } from "../../config/env-schema.js";
import type { Logger } from "../../logger.js";
import { expectedAudiences } from "../../config/validate-config.js";
import {
  discoverAuthorizationServer,
  type FetchLike,
} from "./discover-metadata.js";
import {
  createRemoteKeyResolver,
  createTokenVerifier,
  type TokenVerifier,
} from "./verify-token.js";

export interface OAuthSetup {
  verifier: TokenVerifier;
  issuer: string;
  audiences: string[];
  jwksUri: string;
}

/**
 * Discovery runs before the listener opens, so an IdP that accepts the connection and never
 * answers holds the whole startup — undici bounds a bodyless fetch only by its 300 s
 * `headersTimeout`, and Entra's issuer yields three candidates to try in turn. The Ivanti probe
 * already learned this (`PROBE_TIMEOUT_MS`); this is the same bound for the same reason.
 */
export const DISCOVERY_TIMEOUT_MS = 10_000;

const defaultFetch: FetchLike = (url) =>
  fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });

/**
 * Resolves the signing keys and builds the verifier.
 *
 * Discovery happens once at startup so a wrong issuer fails immediately, rather than turning
 * into a puzzling 401 on the first real request.
 */
export async function createOAuthSetup(
  config: Config,
  fetchImpl: FetchLike = defaultFetch,
  /**
   * Where an IdP outage is reported. Optional only for tests: without it the verifier's 503s and
   * the key set's fallback to its last good copy are invisible, which is the one place either
   * could be seen at all.
   */
  logger?: Logger,
): Promise<OAuthSetup> {
  const issuer = config.OAUTH_ISSUER;
  const audiences = expectedAudiences(config);

  if (issuer === undefined || audiences.length === 0) {
    throw new Error(
      "AUTH_MODE=oauth requires OAUTH_ISSUER and at least one audience.",
    );
  }

  const jwksUri =
    config.OAUTH_JWKS_URI ??
    (await discoverAuthorizationServer(issuer, fetchImpl)).jwks_uri;

  return {
    verifier: createTokenVerifier({
      issuer,
      audience: audiences,
      requiredScopes: config.OAUTH_REQUIRED_SCOPES,
      keyResolver: createRemoteKeyResolver(jwksUri, logger === undefined ? {} : { logger }),
      ...(logger === undefined ? {} : { logger }),
    }),
    issuer,
    audiences,
    jwksUri,
  };
}
