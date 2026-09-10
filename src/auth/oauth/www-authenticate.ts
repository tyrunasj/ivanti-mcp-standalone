export type ChallengeError = 'invalid_token' | 'insufficient_scope';

export interface ChallengeOptions {
  resourceMetadataUrl: string;
  scope?: readonly string[];
  error?: ChallengeError;
  errorDescription?: string;
}

const quote = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;

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
