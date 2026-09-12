import type { Config } from '../../config/env-schema.js';

/**
 * Which quick actions an audience may run.
 *
 * Quick actions are the right way to close, reopen or cancel something — they run the tenant's own
 * procedure rather than writing a status and skipping whatever that procedure does. But Ivanti
 * scopes the list by role and this server signs in as **one** account: on an admin key a stock
 * incident offers 104 actions, including escalation notifications and analyst-only composites. An
 * `enduser` deployment must not offer those just because the service account can see them.
 *
 * So the deployment names the ones it wants, by name, in `ENDUSER_QUICK_ACTIONS`. Deliberately not
 * inferred from the action's name or type: "Close From Self Service" is this tenant's wording, not
 * Ivanti's, and a server guessing at tenant text is how one object's names become the general rule.
 *
 * Empty means **none** — the same fail-closed shape `ENDUSER_BUSINESS_OBJECTS` has. A deployment
 * that wants end users closing their own tickets says so.
 */
export interface ActionGate {
  /** The action names this audience may run. Empty with `restricted` means none at all. */
  readonly allowed: readonly string[];
  readonly restricted: boolean;
  allows: (name: string) => boolean;
}

/** What `full` mode gets: the tenant's whole surface, because that is the audience's job. */
export const OPEN_ACTIONS: ActionGate = {
  allowed: [],
  restricted: false,
  allows: () => true,
};

export function createActionGate(config: Config): ActionGate {
  if (config.MCP_MODE !== 'enduser') return OPEN_ACTIONS;

  const allowed = config.ENDUSER_QUICK_ACTIONS;
  // Compared case-insensitively and trimmed: an admin copying a name out of Ivanti should not
  // have to match its spacing exactly.
  const permitted = new Set(allowed.map((name) => name.trim().toLowerCase()));

  return {
    allowed,
    restricted: true,
    allows: (name: string): boolean => permitted.has(name.trim().toLowerCase()),
  };
}

export class ActionNotAllowedError extends Error {
  constructor(name: string, allowed: readonly string[]) {
    super(
      allowed.length === 0
        ? `This server does not let end users run '${name}', or any other quick action. Tell ` +
            'them what needs doing and let them do it in Ivanti.'
        : `This server does not let end users run '${name}'. It allows: ${allowed.join(', ')}.`,
    );
    this.name = 'ActionNotAllowedError';
  }
}
