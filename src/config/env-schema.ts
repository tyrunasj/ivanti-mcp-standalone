// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { z } from 'zod';
import { toCsdlEntity } from '../ivanti/metadata/entity-names.js';
import { LOG_LEVELS } from '../logger.js';

/** The door: may this client talk to the server at all? Only meaningful over HTTP. */
export const AUTH_MODES = ['none', 'bearer', 'oauth'] as const;

export const MCP_MODES = ['full', 'enduser'] as const;

export type AuthMode = (typeof AUTH_MODES)[number];
export type McpMode = (typeof MCP_MODES)[number];

const commaSeparated = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

/**
 * The shape of configuration only. Cross-field rules live in `validate-config.ts`
 * so that "what a setting is" stays separate from "which combinations are allowed".
 */
export const envSchema = z.object({
  /**
   * Transports are independent toggles rather than one list, so that a deployment can flip a
   * single one without restating the others — which is how layered env config (compose
   * overrides, k8s) actually gets edited. At least one must be on.
   */
  STDIO_TRANSPORT_ON: z.stringbool().default(true),
  HTTP_TRANSPORT_ON: z.stringbool().default(false),

  /**
   * Required for `http`, and rejected for `stdio` — under stdio the credential is the ability
   * to run the process, so an auth mode there would only give a false sense of protection.
   */
  AUTH_MODE: z.enum(AUTH_MODES).optional(),

  MCP_MODE: z.enum(MCP_MODES).default('full'),

  // Loopback by default: exposing the server to a network is a separate, explicit act.
  MCP_BIND: z.string().default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  MCP_PUBLIC_URL: z.url().optional(),
  TRUSTED_ORIGINS: commaSeparated.default([]),

  /** Idle sessions are closed after this long — clients often vanish without a DELETE. */
  MCP_SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  /**
   * How long a conversation may go quiet before the pinned identity is forgotten.
   *
   * Separate from the session TTL, which it once borrowed, because the two answer different
   * questions about different things. That one bounds server memory and wants to be short; this
   * one decides how long a person's records stay reachable to whoever is at the keyboard, and on
   * stdio — one connection for the life of the process — it is the ONLY thing that ends a
   * conversation. Tuning one should not silently move the other.
   *
   * Biased short on purpose: expiring too eagerly costs one more `act_as`, expiring too late
   * answers the next conversation with the last person's records.
   */
  MCP_IDENTITY_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  /** Ceiling on concurrent sessions: unbounded growth is a DoS surface in `none` mode. */
  MCP_MAX_SESSIONS: z.coerce.number().int().positive().default(100),

  BEARER_TOKEN: z.string().min(1).optional(),

  OAUTH_ISSUER: z.url().optional(),
  /**
   * Accepted `aud` values, comma-separated. Defaults to MCP_PUBLIC_URL.
   *
   * A list rather than a single value because no mainstream IdP mints the audience from the
   * client's RFC 8707 `resource` parameter — Zitadel emits a project or client id, Entra an App
   * ID URI — and a deployment routinely has more than one legitimate client. A token is
   * accepted when its `aud` contains **any** of these.
   */
  OAUTH_AUDIENCE: commaSeparated.default([]),
  /** Overrides discovery when the IdP's JWKS is not at the conventional location. */
  OAUTH_JWKS_URI: z.url().optional(),
  OAUTH_SCOPES_SUPPORTED: commaSeparated.default([]),
  OAUTH_REQUIRED_SCOPES: commaSeparated.default([]),
  /**
   * Which claim names the person, for matching against Ivanti.
   *
   * Not `sub`, which is what identifies the *token's* subject: Entra's is an opaque pairwise
   * identifier that appears nowhere in Ivanti. Providers disagree on where the human-readable
   * one lives — Entra sends `preferred_username` or `upn`, most others `email` — so the default
   * is a probe order over those, and this pins it when a tenant does something else.
   */
  OAUTH_IDENTITY_CLAIM: z.string().min(1).optional(),

  /**
   * Which quick actions an `enduser` deployment may run, by name.
   *
   * A gate, and empty means none — the same shape as `ENDUSER_BUSINESS_OBJECTS`. Quick actions
   * are the tenant's own procedures and the right way to close, reopen or cancel something, but
   * Ivanti scopes the list by role and this server signs in as one account: on an admin key a
   * stock incident offers **104** of them, including escalation notifications and analyst-only
   * composites. So the deployment names the handful an end user should have rather than the
   * server guessing from action names, which are tenant text.
   *
   * `full` mode is unaffected: IT staff get the whole surface.
   */
  ENDUSER_QUICK_ACTIONS: commaSeparated.default([]),

  /**
   * The Ivanti tenant. Optional while the Ivanti tools are still being built — without it the
   * server runs with only the transport-level tools.
   */
  IVANTI_BASE_URL: z.url().optional(),
  /** One key, one Ivanti "MCP user" — see design §3. Also accepted as IVANTI_API_KEY_FILE. */
  IVANTI_API_KEY: z.string().min(1).optional(),
  /**
   * Caps what the server will use, however capable the credential turns out to be.
   *
   * There is no other way to exercise the degraded paths: `AuthenticateTenantAPIKey`'s `role`
   * argument is ignored — an admin account asked for `SelfService` still answers `Admin` — so a
   * deployment cannot test what a customer without admin rights will see by asking nicely.
   */
  IVANTI_MAX_TIER: z.enum(['odata', 'session', 'admin']).optional(),

  /**
   * The ConfigDB tenant, e.g. `https://config-<tenant>/`.
   *
   * Set together with `IVANTI_CENTRAL_CONFIG_API_KEY`, this turns `act_as` from a preference
   * into an identity Ivanti itself enforces: CentralConfig mints a session for the named person
   * and OData applies *their* access to it. With neither set the server behaves exactly as it
   * does without them — see `docs/impersonation-plan.md`.
   */
  IVANTI_CONFIG_URL: z.url().optional(),
  /**
   * The key from the ConfigDB tenant's Configure → Security Controls → API Keys, in the
   * `CentralConfigApiKey` group. Also accepted as IVANTI_CENTRAL_CONFIG_API_KEY_FILE.
   *
   * It is not the tenant API key and cannot be substituted for one: it authenticates against
   * CentralConfig, which answers with the tenant's database credentials among other things.
   */
  IVANTI_CENTRAL_CONFIG_API_KEY: z.string().min(1).optional(),
  /**
   * Pins which of the person's roles an impersonated session opens under, in `full` mode.
   *
   * Without it the session keeps whichever non-self-service role Ivanti made active. The role is
   * used when the person holds it and refused when they do not, rather than silently ignored —
   * a deployment that asked for a role and got a weaker one should be told.
   */
  IVANTI_IMPERSONATION_ROLE: z.string().min(1).optional(),

  /**
   * Business Objects an end user may create on. Any of Ivanti's three naming dialects is
   * accepted and normalised to one — `Incident#`, `Incidents` and `incident` name the same
   * object, and an allowlist that missed by dialect would fail open or closed for no reason a
   * reader could see.
   */
  ENDUSER_BUSINESS_OBJECTS: commaSeparated.default([]).transform((objects) =>
    // BOTH spellings, not just the singularised guess. `toCsdlEntity` strips a trailing `s`,
    // which is right for `Incidents` and wrong for every object whose own CSDL name ends in one —
    // `journal__notes`, `address`, `nrn_roomreservations`, `frs_surveyresults` are all real here.
    // Collapsing to the guess either exited 78 telling the operator to type the name they had
    // just typed, or started with the object permanently unreachable while every refusal listed
    // it as allowed. `catalog.ts` already fixed exactly this trap for `entity()`; keeping the raw
    // form alongside the converted one is the same answer.
    //
    // The `#` dialect is dropped from the raw side: `toCsdlEntity` already resolves it, and
    // `ENDUSER_BUSINESS_OBJECTS` is read back to the caller in every refusal, so the list should
    // not carry spellings nothing will ever look up.
    [
      ...new Set(
        objects.flatMap((object) => [
          ...(object.includes('#') ? [] : [object.toLowerCase()]),
          toCsdlEntity(object).toLowerCase(),
        ]),
      ),
    ],
  ),

  /**
   * The Ivanti role an impersonated `enduser` session opens under.
   *
   * A tenant renames roles, so this is a setting rather than a constant. It is resolved against
   * the person's OWN roles when `act_as` opens their session — per call, not at startup: a name
   * this tenant does not use is reported in that call's `roleNote` and the session keeps whichever
   * role Ivanti made active. `ENDUSER_BUSINESS_OBJECTS` is the one setting checked against the
   * tenant at boot, and the asymmetry is deliberate: a wrong object silently narrows what an end
   * user may do, where a wrong role says so on the first call. The default is the role Ivanti
   * ships for the mobile self-service portal.
   *
   * It is named rather than derived on purpose. Ivanti flags its self-service roles
   * (`SelfServiceRole` on `GetUserData.userRoleList`), but several qualify and they are not
   * interchangeable — this says which one. Ignored outside `enduser`, like the other
   * `ENDUSER_*` settings.
   */
  ENDUSER_ROLE: z.string().min(1).default('SelfServiceMobile'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type Config = z.infer<typeof envSchema>;
