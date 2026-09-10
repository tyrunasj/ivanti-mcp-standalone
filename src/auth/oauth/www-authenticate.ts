export type ChallengeError = 'invalid_token' | 'insufficient_scope';

export interface ChallengeOptions {
  resourceMetadataUrl: string;
  scope?: readonly string[];
  error?: ChallengeError;
  errorDescription?: string;
}

const MAX_DESCRIPTION = 200;

/**
 * RFC 6750 restricts these values to %x20-21 / %x23-5B / %x5D-7E — printable ASCII minus the
 * quote and backslash. Node rejects anything outside Latin-1 outright, so an em dash in a
 * message turns a clean 401 into a 500. Sanitise rather than trust the caller: the description
 * is prose, and prose acquires punctuation.
 */
const headerSafe = (value: string): string =>
  value
    .replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION);

const quote = (value: string): string => `"${headerSafe(value)}"`;

/**
 * Builds the `WWW-Authenticate` challenge.
 *
 * `resource_metadata` is one of the two discovery mechanisms the spec allows, and the one
 * clients try first — it lets a client find the authorization server from a 401 alone, with
 * no prior configuration. `scope` tells the client what to ask for rather than making it
 * guess, which is why the spec says to include it.
 */
export function buildWwwAuthenticate(options: ChallengeOptions): string {
  const parts: string[] = [];

  if (options.error !== undefined) {
    parts.push(`error=${quote(options.error)}`);
  }
  if (options.errorDescription !== undefined) {
    parts.push(`error_description=${quote(options.errorDescription)}`);
  }
  if (options.scope !== undefined && options.scope.length > 0) {
    parts.push(`scope=${quote(options.scope.join(' '))}`);
  }
  parts.push(`resource_metadata=${quote(options.resourceMetadataUrl)}`);

  return `Bearer ${parts.join(', ')}`;
}
