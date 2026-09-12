import type { VerifiedIdentity } from './oauth/verify-token.js';

/**
 * Who a call is *for*, and how that was established.
 *
 * Kept separate from the auth mode, which is the **door** — whether a client may talk to this
 * server at all. A shared bearer token opens the door for everyone who holds it and says nothing
 * about the person on the other end; an OAuth token says exactly who they are. Both are legitimate
 * deployments, so identity is a value threaded through calls rather than something a handler can
 * reach for.
 *
 * The provenance is part of the type because the three are not interchangeable: `verified` is
 * vouched for by an issuer, `asserted` is a claim the caller made about themselves, and
 * `anonymous` is the absence of both. Ivanti ticket text is written by whoever filed the ticket,
 * so a claim that arrives through a tool argument can have come from a ticket — which is why the
 * two are never merged.
 */
export type IdentityProvenance = 'anonymous' | 'asserted' | 'verified';

export interface CallerIdentity {
  readonly provenance: IdentityProvenance;
  /** The token's subject, or the claimed login. Absent when anonymous. */
  readonly subject?: string;
  /** Who vouched. Only ever set on a verified identity. */
  readonly issuer?: string;
}

export const ANONYMOUS: CallerIdentity = { provenance: 'anonymous' };

/** A claim the caller made about themselves. Nothing has checked it. */
export function assertedIdentity(subject: string): CallerIdentity {
  return { provenance: 'asserted', subject };
}

/** An identity an issuer vouched for, from a token this server verified. */
export function verifiedIdentity(identity: VerifiedIdentity): CallerIdentity {
  return { provenance: 'verified', subject: identity.subject, issuer: identity.issuer };
}

/**
 * What may be logged about an identity.
 *
 * The provenance always; the subject only when an issuer vouched for it. An *asserted* subject is
 * an unverified claim about a person, and writing it into the log as though it were a fact is how
 * an audit trail starts lying.
 */
export function auditFields(identity: CallerIdentity): Record<string, unknown> {
  return {
    identity: identity.provenance,
    ...(identity.provenance === 'verified' && identity.subject !== undefined
      ? { subject: identity.subject }
      : {}),
  };
}
