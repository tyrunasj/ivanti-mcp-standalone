/**
 * Origin validation for the streamable HTTP transport.
 *
 * The spec requires servers to validate `Origin` and answer 403 when it is present and
 * invalid, to prevent DNS rebinding. It matters most in open mode: a page the user
 * merely visits can otherwise drive a server that has no other authentication.
 *
 * A missing `Origin` is allowed — non-browser clients do not send one, and browsers
 * always do.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}
