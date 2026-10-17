import { describe, expect, it } from 'vitest';
import { prLink } from '../src/lib/pr-url.js';

describe('prLink', () => {
  it('strips the tracking suffixes the PR heartbeats append', () => {
    expect(prLink('https://github.com/ExampleOrg/aegis/pull/817/closed')).toBe('https://github.com/ExampleOrg/aegis/pull/817');
    expect(prLink('https://github.com/ExampleOrg/aegis/pull/817/merged')).toBe('https://github.com/ExampleOrg/aegis/pull/817');
  });

  it('leaves a plain PR URL and null alone', () => {
    expect(prLink('https://github.com/ExampleOrg/aegis/pull/817')).toBe('https://github.com/ExampleOrg/aegis/pull/817');
    expect(prLink(null)).toBeNull();
  });
});
