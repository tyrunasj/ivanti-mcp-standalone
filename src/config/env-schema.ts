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
   * Business Objects an end user may create on. Any of Ivanti's three naming dialects is
   * accepted and normalised to one — `Incident#`, `Incidents` and `incident` name the same
   * object, and an allowlist that missed by dialect would fail open or closed for no reason a
   * reader could see.
   */
  ENDUSER_BUSINESS_OBJECTS: commaSeparated
    .default([])
    .transform((objects) => objects.map((object) => toCsdlEntity(object).toLowerCase())),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

export type Config = z.infer<typeof envSchema>;
