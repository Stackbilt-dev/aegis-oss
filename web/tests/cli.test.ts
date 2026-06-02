import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';

describe('aegis CLI', () => {
  it('prints help without requiring a token', () => {
    const out = execFileSync(process.execPath, ['cli/aegis.mjs', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(out).toContain('AEGIS CLI');
    expect(out).toContain('--host <host>');
    expect(out).toContain('/new  /exec [name]');
  });

  it('prints package version without requiring a token', () => {
    const out = execFileSync(process.execPath, ['cli/aegis.mjs', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('fails clearly when no token is configured', () => {
    const result = spawnSync(process.execPath, ['cli/aegis.mjs', '--quick'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, AEGIS_TOKEN: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing AEGIS_TOKEN');
  });
});
