// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { voteOwnership } from './vote-owner.js';

const JOHN = { recId: 'E1', loginId: 'jsmith', primaryEmail: 'john.smith@x.eu', displayName: 'John Smith' };

describe('voteOwnership', () => {
  it('lets Owner_Valid decide alone when the row has one', () => {
    expect(voteOwnership(JOHN, { Owner: 'somebody-else', Owner_Valid: 'e1' })).toBe('theirs');
    expect(voteOwnership(JOHN, { Owner: 'John Smith', Owner_Valid: 'E2' })).toBe('namesake');
    expect(voteOwnership(JOHN, { Owner: 'HSanders', Owner_Valid: 'E2' })).toBe('someone-else');
  });

  it('falls back to the spellings of Owner only when Owner_Valid is empty', () => {
    expect(voteOwnership(JOHN, { Owner: 'John   Smith', Owner_Valid: '' })).toBe('theirs');
    expect(voteOwnership(JOHN, { Owner: 'JOHN.SMITH@X.EU' })).toBe('theirs');
    expect(voteOwnership(JOHN, { Owner: 'jsmith2' })).toBe('someone-else');
    expect(voteOwnership(JOHN, { Owner: '' })).toBe('someone-else');
  });

  it('never matches on an identifier the person does not have', () => {
    expect(voteOwnership({ displayName: 'John Smith' }, { Owner: '', Owner_Valid: '' })).toBe(
      'someone-else',
    );
  });
});
