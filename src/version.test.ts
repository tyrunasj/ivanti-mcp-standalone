import { describe, expect, it, vi } from 'vitest';
import { readPackageMetadata } from './version.js';

describe('readPackageMetadata', () => {
  it('resolves the real package.json without a stub', () => {
    // Asserts shape, not the literal name: the name is a product name and may change.
    const metadata = readPackageMetadata();

    expect(metadata.name.length).toBeGreaterThan(0);
    expect(metadata.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the name and version from the manifest', () => {
    const read = vi.fn().mockReturnValue('{"name":"pkg","version":"1.2.3"}');

    expect(readPackageMetadata(read)).toEqual({ name: 'pkg', version: '1.2.3' });
  });

  it('explains how a container can be missing the manifest', () => {
    const read = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => readPackageMetadata(read)).toThrow(/must copy package.json alongside dist/);
  });

  it('rejects malformed JSON', () => {
    expect(() => readPackageMetadata(() => 'not json')).toThrow(/Could not read/);
  });

  it('rejects a manifest with no version', () => {
    expect(() => readPackageMetadata(() => '{"name":"pkg"}')).toThrow(/no usable "version"/);
  });

  it('rejects a manifest with no name', () => {
    expect(() => readPackageMetadata(() => '{"version":"1.0.0"}')).toThrow(/no usable "name"/);
  });
});
