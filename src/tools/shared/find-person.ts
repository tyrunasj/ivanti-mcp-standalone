import type { IvantiConnection } from '../../ivanti/connect.js';
import type { PersonCandidate } from '../../ivanti/people/directory.js';

/**
 * Turning whatever a caller typed into a person, by the one resolver the server already has.
 *
 * Three tools take a `person` argument and they had three different contracts: `act_as` resolves
 * a login, an email OR a full name through the person directory; `list_assigned_work` runs its
 * own three-field ladder and refuses by name on a miss; `list_approvals` matched it as a near-raw
 * string. That third one was the dangerous shape — asking for "Becky Smith" returned an empty
 * queue carrying a note asserting she "has never been asked to approve anything", when she has
 * four approval rows. The same sentence came back for a person who does not exist.
 *
 * The lesson generalises past the bug: a reassuring note about an empty result is only true when
 * the INPUT resolved to something real. Resolve first, refuse when you cannot, and only then say
 * what the absence means.
 *
 * This delegates to the directory rather than matching fields itself, because the naive ladder is
 * wrong in a way that looks right: an exact match on `DisplayName` misses "Becky Smith", whose
 * stored display name is `Becky   Smith` with three spaces. DisplayName is assembled from the
 * name parts and carries the middle name, so the directory matches FirstName + LastName on whole
 * tokens instead — which is why `act_as` accepts a full name and a hand-rolled `eq` does not.
 */
export interface FoundPerson {
  loginId: string;
  displayName: string;
  recId: string;
  /** Which key matched, so an answer can show its own working. */
  matchedOn: string;
  email?: string;
}

export async function findPerson(
  connection: IvantiConnection,
  claim: string,
): Promise<FoundPerson | undefined> {
  const candidates: PersonCandidate[] = await connection.people.directory
    .find(claim)
    .catch(() => []);

  // Exactly one, or nothing: an ambiguous claim is not a resolution, and a tool that silently
  // took the first of three people would be worse than one that refused.
  const [only] = candidates;
  if (only === undefined || candidates.length > 1) return undefined;
  if (only.loginId === undefined || only.loginId === '') return undefined;

  return {
    loginId: only.loginId,
    displayName: only.displayName,
    recId: only.recId,
    matchedOn: only.matchedOn,
    ...(only.primaryEmail === undefined ? {} : { email: only.primaryEmail }),
  };
}
