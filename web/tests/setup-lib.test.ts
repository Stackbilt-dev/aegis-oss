import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper without type declarations
import { findDatabaseId, generateToken, migrationAlreadyApplied, migrationFiles, renderWranglerToml, workerNameError, workerUrlFromDeployOutput } from '../scripts/setup-lib.mjs';
import { readdirSync } from 'node:fs';

const example = readFileSync(join(__dirname, '..', 'wrangler.toml.example'), 'utf8');

describe('workerNameError', () => {
  it('accepts valid Worker names and rejects the rest', () => {
    expect(workerNameError('my-agent')).toBeNull();
    expect(workerNameError('a1')).toBeNull();
    expect(workerNameError('')).toMatch(/required/);
    expect(workerNameError('My-Agent')).toMatch(/lowercase/);
    expect(workerNameError('-agent')).toMatch(/lowercase/);
    expect(workerNameError('agent_1')).toMatch(/lowercase/);
    expect(workerNameError('a'.repeat(64))).toMatch(/63/);
  });
});

describe('renderWranglerToml', () => {
  it('fills the committed example: name, database name and id, optional account', () => {
    const toml = renderWranglerToml(example, {
      name: 'ada-agent',
      databaseName: 'ada-agent',
      databaseId: '11111111-2222-3333-4444-555555555555',
      accountId: 'abc123',
    });
    expect(toml).toMatch(/^name = "ada-agent"$/m);
    expect(toml).toMatch(/^database_name = "ada-agent"$/m);
    expect(toml).toMatch(/^database_id = "11111111-2222-3333-4444-555555555555"$/m);
    expect(toml).toMatch(/^account_id = "abc123"$/m);
    expect(toml).not.toContain('YOUR_DATABASE_ID');
    // Everything else, including the commented-out sandbox executor block, is untouched.
    expect(toml).toContain('# [[containers]]');
    expect(toml.split('\n').length).toBe(example.split('\n').length);
  });

  it('refuses an example whose placeholders moved', () => {
    expect(() => renderWranglerToml('main = "x"\n', { name: 'a', databaseName: 'a', databaseId: 'b' })).toThrow(/name/);
  });
});

describe('findDatabaseId', () => {
  const list = JSON.stringify([{ name: 'other', uuid: 'u-1' }, { name: 'ada-agent', uuid: 'u-2' }]);
  it('finds the database by exact name', () => {
    expect(findDatabaseId(list, 'ada-agent')).toBe('u-2');
    expect(findDatabaseId(list, 'ada')).toBeNull();
    expect(findDatabaseId('not json', 'ada-agent')).toBeNull();
  });
});

describe('workerUrlFromDeployOutput', () => {
  it('reads the workers.dev URL from deploy output', () => {
    expect(workerUrlFromDeployOutput('Deployed ada-agent triggers\n  https://ada-agent.ada.workers.dev\nCurrent Version ID: x'))
      .toBe('https://ada-agent.ada.workers.dev');
    expect(workerUrlFromDeployOutput('no url here')).toBeNull();
  });
});

describe('generateToken', () => {
  it('is 64 hex characters and not repeated', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(token);
  });
});

describe('migrations', () => {
  it('orders migration files and ignores everything else', () => {
    expect(migrationFiles(['0002_b.sql', 'README.md', '0001_a.sql', 'x.sql'])).toEqual(['0001_a.sql', '0002_b.sql']);
  });

  it('includes every migration in the repo', () => {
    const files = readdirSync(join(__dirname, '..', 'migrations'));
    expect(migrationFiles(files)).toEqual(files.filter((f) => f.endsWith('.sql')).sort());
    expect(migrationFiles(files)).toContain('0002_cc_tasks_approval.sql');
  });

  it('treats only an existing column as already applied', () => {
    expect(migrationAlreadyApplied('✘ [ERROR] duplicate column name: approved_at: SQLITE_ERROR')).toBe(true);
    expect(migrationAlreadyApplied('no such table: cc_tasks')).toBe(false);
    expect(migrationAlreadyApplied(undefined)).toBe(false);
  });
});
