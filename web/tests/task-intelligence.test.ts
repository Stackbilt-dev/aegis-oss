import { describe, expect, it } from 'vitest';
import {
  classifyTaskFailure,
  collectContractAlerts,
  parseTaskAutopsy,
  parseTaskPreflight,
} from '../src/task-intelligence.js';

describe('task intelligence', () => {
  it('parses preflight payloads from JSON strings', () => {
    const parsed = parseTaskPreflight('{"repo":"aegis","repo_exists":true,"warnings":["warn"]}');
    expect(parsed).toEqual({
      repo: 'aegis',
      repo_exists: true,
      warnings: ['warn'],
    });
  });

  it('returns null for invalid autopsy JSON', () => {
    expect(parseTaskAutopsy('{bad json')).toBeNull();
  });

  it('classifies missing repos as non-retryable system-contract failures', () => {
    const autopsy = classifyTaskFailure({
      title: 'Scaffold deploy pipeline',
      repo: 'kurtovermier.com',
      error: 'Repo not found: kurtovermier.com',
      preflight: {
        repo: 'kurtovermier.com',
        repo_exists: false,
        warnings: ['Resolved repo path does not exist on this runner'],
      },
    });

    expect(autopsy.kind).toBe('repo_missing');
    expect(autopsy.retryable).toBe(false);
    expect(autopsy.system_contract).toBe('repo_target_missing');
  });

  it('classifies missing test surfaces for test tasks', () => {
    const autopsy = classifyTaskFailure({
      category: 'tests',
      preflight: {
        repo: 'aegis-daemon',
        repo_exists: true,
        warnings: ['No obvious test command detected in root/web/e2e package.json'],
      },
    });

    expect(autopsy.kind).toBe('test_command_missing');
    expect(autopsy.system_contract).toBe('repo_test_surface_missing');
  });

  it('classifies draft 404s as route contract gaps', () => {
    const autopsy = classifyTaskFailure({
      error: '404',
      result: 'Draft post returned a public URL but the public post route does not exist yet',
    });

    expect(autopsy.kind).toBe('route_contract_gap');
    expect(autopsy.system_contract).toBe('content_public_route_drift');
  });

  it('deduplicates contract alerts by contract and repo', () => {
    const alerts = collectContractAlerts([
      {
        id: 'task-1',
        repo: 'aegis',
        completed_at: '2026-03-11T12:00:00Z',
        autopsy_json: JSON.stringify({
          kind: 'route_contract_gap',
          retryable: false,
          summary: 'Draft content was treated as public',
          recommended_action: 'Repair the route contract.',
          signals: [],
          system_contract: 'content_public_route_drift',
        }),
      },
      {
        id: 'task-2',
        repo: 'aegis',
        completed_at: '2026-03-11T12:30:00Z',
        autopsy_json: JSON.stringify({
          kind: 'route_contract_gap',
          retryable: false,
          summary: 'Draft content was treated as public again',
          recommended_action: 'Repair the route contract.',
          signals: [],
          system_contract: 'content_public_route_drift',
        }),
      },
      {
        id: 'task-3',
        repo: 'charter',
        completed_at: '2026-03-11T13:00:00Z',
        autopsy_json: JSON.stringify({
          kind: 'repo_missing',
          retryable: false,
          summary: 'Repo target missing',
          recommended_action: 'Fix the repo alias.',
          signals: [],
          system_contract: 'repo_target_missing',
        }),
      },
    ]);

    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      contract: 'content_public_route_drift',
      repo: 'aegis',
      task_id: 'task-1',
    });
    expect(alerts[1]).toMatchObject({
      contract: 'repo_target_missing',
      repo: 'charter',
      task_id: 'task-3',
    });
  });
});
