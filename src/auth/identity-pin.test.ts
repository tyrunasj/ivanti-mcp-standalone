import { describe, expect, it } from 'vitest';
import { createIdentityPins, IdentityConflictError, initialIdentity } from './identity-pin.js';
import { ANONYMOUS, assertedIdentity, verifiedIdentity } from './identity.js';

const VERIFIED = verifiedIdentity({
  subject: '367708',
  issuer: 'https://idp',
  scopes: [],
  claims: {},
});

describe('createIdentityPins', () => {
  it('pins the first claim and keeps it', () => {
    const pins = createIdentityPins();

    expect(pins.resolve('s1', ANONYMOUS, 'jsmith')).toEqual(assertedIdentity('jsmith'));
    // A later call with no claim still acts for the pinned person.
    expect(pins.resolve('s1', ANONYMOUS)).toEqual(assertedIdentity('jsmith'));
  });

  it('refuses a second, different claim rather than switching', () => {
    // The new name may have come from a ticket the conversation just read.
    const pins = createIdentityPins();
    pins.resolve('s1', ANONYMOUS, 'jsmith');

    expect(() => pins.resolve('s1', ANONYMOUS, 'adale')).toThrow(IdentityConflictError);
    expect(() => pins.resolve('s1', ANONYMOUS, 'adale')).toThrow(/already acting for 'jsmith'/);
  });

  it('accepts the same claim repeated', () => {
    const pins = createIdentityPins();
    pins.resolve('s1', ANONYMOUS, 'jsmith');

    expect(pins.resolve('s1', ANONYMOUS, ' jsmith ')).toEqual(assertedIdentity('jsmith'));
  });

  it('ignores a claim entirely when the session is verified', () => {
    // Not merged, not preferred: otherwise the strong path has a bypass around it.
    const pins = createIdentityPins();

    expect(pins.resolve('s1', VERIFIED, 'someone-else')).toEqual(VERIFIED);
    expect(pins.size()).toBe(0);
  });

  it('keeps sessions apart', () => {
    const pins = createIdentityPins();
    pins.resolve('s1', ANONYMOUS, 'jsmith');

    expect(pins.resolve('s2', ANONYMOUS, 'adale')).toEqual(assertedIdentity('adale'));
    expect(pins.size()).toBe(2);
  });

  it('forgets a session when it closes', () => {
    const pins = createIdentityPins();
    pins.resolve('s1', ANONYMOUS, 'jsmith');

    pins.forget('s1');

    expect(pins.size()).toBe(0);
    // A fresh session may act for someone else.
    expect(pins.resolve('s1', ANONYMOUS, 'adale')).toEqual(assertedIdentity('adale'));
  });

  it('has nothing to pin to without a session', () => {
    // stdio is one process and one conversation; there is no second session to confuse it with.
    const pins = createIdentityPins();

    expect(pins.resolve(undefined, ANONYMOUS, 'jsmith')).toEqual(assertedIdentity('jsmith'));
    expect(pins.size()).toBe(0);
  });
});

describe('initialIdentity', () => {
  it('is the verified identity when there is one, and anonymous otherwise', () => {
    expect(initialIdentity(VERIFIED)).toBe(VERIFIED);
    expect(initialIdentity(undefined)).toEqual(ANONYMOUS);
  });
});
