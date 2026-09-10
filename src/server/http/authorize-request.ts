import { timingSafeEqual } from 'node:crypto';
import type { TokenVerifier, VerifiedIdentity } from '../../auth/oauth/verify-token.js';
import { buildWwwAuthenticate } from '../../auth/oauth/www-authenticate.js';
import type { Config } from '../../config/env-schema.js';

export interface AuthorizationResult {
  authorized: boolean;
  status: number;
  reason?: string;
  identity?: VerifiedIdentity;
  /** `WWW-Authenticate` value, when the response should carry a challenge. */
  challenge?: string;
}

export interface AuthorizationContext {
  verifier?: TokenVerifier;
  /** Absolute URL of the Protected Resource Metadata document. */
  resourceMetadataUrl?: string;
}

const OK: AuthorizationResult = { authorized: true, status: 200 };

export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token === '' ? undefined : token;
}

function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // Compare lengths first: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Applies the configured auth mode to one request.
 *
 * The auth mode is the door — whether this client may talk to the server at all. It is not the
 * identity of the person an operation is *for*; that is the `Customer` field.
 */
export async function authorizeRequest(
  config: Config,
  headers: Record<string, string | undefined>,
  context: AuthorizationContext = {},
): Promise<AuthorizationResult> {
  switch (config.AUTH_MODE) {
    case 'none':
      return OK;

    case 'bearer': {
      const token = extractBearerToken(headers.authorization);
      if (token === undefined) {
        return { authorized: false, status: 401, reason: 'Missing bearer token' };
      }
      if (config.BEARER_TOKEN === undefined || !tokensMatch(token, config.BEARER_TOKEN)) {
        return { authorized: false, status: 401, reason: 'Invalid bearer token' };
      }
      return OK;
    }

    case 'oauth': {
      const { verifier, resourceMetadataUrl } = context;
      if (verifier === undefined || resourceMetadataUrl === undefined) {
        return {
          authorized: false,
          status: 500,
          reason: 'OAuth verifier was not initialised',
        };
      }

      const token = extractBearerToken(headers.authorization);
      if (token === undefined) {
        // No token yet: challenge without an error code, so the client discovers the
        // authorization server from this response alone.
        return {
          authorized: false,
          status: 401,
          reason: 'Missing bearer token',
          challenge: buildWwwAuthenticate({
            resourceMetadataUrl,
            scope: config.OAUTH_REQUIRED_SCOPES,
          }),
        };
      }

      const verification = await verifier(token);
      if (!verification.ok) {
        return {
          authorized: false,
          status: verification.status,
          reason: verification.description,
          challenge: buildWwwAuthenticate({
            resourceMetadataUrl,
            error: verification.error,
            errorDescription: verification.description,
            scope: config.OAUTH_REQUIRED_SCOPES,
          }),
        };
      }

      return { ...OK, identity: verification.identity };
    }

    default:
      return {
        authorized: false,
        status: 501,
        reason: `AUTH_MODE=${config.AUTH_MODE} is not served over HTTP`,
      };
  }
}
