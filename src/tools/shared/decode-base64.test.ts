// SPDX-License-Identifier: LicenseRef-SYNERGY-Commercial
// Copyright (c) 2026 SYNERGY. All rights reserved.

import { describe, expect, it } from 'vitest';
import { decodeBase64Argument } from './decode-base64.js';

describe('decodeBase64Argument', () => {
  it('refuses text with a bad character in the middle rather than decoding the prefix', () => {
    expect(decodeBase64Argument('aGVsbG8=!!!d29ybGQ=')).toBeUndefined();
    expect(decodeBase64Argument('abc$')).toBeUndefined();
  });

  it('decodes valid base64', () => {
    expect(decodeBase64Argument('aGVsbG8gd29ybGQ=')?.toString()).toBe('hello world');
  });

  it('accepts line-wrapped input', () => {
    expect(decodeBase64Argument('aGVsbG8g\r\nd29y\n bGQ=')?.toString()).toBe('hello world');
  });

  it('accepts missing padding, but not an impossible length', () => {
    expect(decodeBase64Argument('aGVsbG8')?.toString()).toBe('hello');
    expect(decodeBase64Argument('aGVsb')).toBeUndefined();
  });

  it('refuses a data: URL and the url-safe alphabet', () => {
    expect(decodeBase64Argument('data:text/plain;base64,aGVsbG8=')).toBeUndefined();
    expect(decodeBase64Argument('a-_b')).toBeUndefined();
  });

  it('decodes empty input to an empty buffer for the caller to judge', () => {
    expect(decodeBase64Argument('')?.byteLength).toBe(0);
  });
});
