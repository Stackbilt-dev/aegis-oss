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
      repo: 'user-website.example',
      error: 'Repo not found: user-website.example',
      preflight: {
        repo: 'user-website.example',
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
        repo: 'my-project',
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

  it('classifies max_turns_exceeded as retryable even when exit code is 1', () => {
    const autopsy = classifyTaskFailure({
      title: 'Post-deploy visual QA: aegis',
      repo: 'aegis',
      error: 'Exit code 1',
      result: '[max_turns_exceeded] Task ran out of turns (12 used, unknown). Increase max_turns or simplify the task.',
      exitCode: 1,
    });

    expect(autopsy.kind).toBe('max_turns_exceeded');
    expect(autopsy.retryable).toBe(true);
  });

  it('classifies max_turns with existing PR as completed-but-unsignaled', () => {
    const autopsy = classifyTaskFailure({
      error: 'Exit code 1',
      result: '[max_turns_exceeded] Task ran out of turns. Pull request created: https://github.com/x/y/pull/1',
      exitCode: 1,
    });

    expect(autopsy.kind).toBe('max_turns_exceeded');
    expect(autopsy.summary).toContain('created a PR');
  });

  it('classifies credit exhaustion as non-retryable runner contract failure', () => {
    const autopsy = classifyTaskFailure({
      error: 'Your credit balance is too low to access the API',
    });

    expect(autopsy.kind).toBe('credit_exhausted');
    expect(autopsy.retryable).toBe(false);
    expect(autopsy.system_contract).toBe('runner_credit_exhausted');
  });

  it('classifies auth failures as runner_auth_degraded', () => {
    const autopsy = classifyTaskFailure({
      error: '401 unauthorized',
      result: 'authentication failed against the provider',
    });

    expect(autopsy.kind).toBe('auth_failure');
    expect(autopsy.system_contract).toBe('runner_auth_degraded');
  });

  it('classifies exit code 3 with npm errors as environment_failure, not completion_signal_missing', () => {
    const autopsy = classifyTaskFailure({
      error: 'npm ERR! install failed',
      result: 'Cannot find module foo',
      exitCode: 3,
    });

    expect(autopsy.kind).toBe('environment_failure');
    expect(autopsy.system_contract).toBe('runner_environment_degraded');
  });

  it('classifies work_already_done when agent reports nothing to do', () => {
    const autopsy = classifyTaskFailure({
      result: 'This issue has already been resolved in commit abc123 — nothing to do',
    });

    expect(autopsy.kind).toBe('work_already_done');
  });

  it('classifies hallucinated tasks from dreaming source', () => {
    const autopsy = classifyTaskFailure({
      title: 'fix: dreaming cycle task',
      result: 'The file referenced in the task does not exist in the repo',
    });

    expect(autopsy.kind).toBe('hallucinated_task');
  });

  it('classifies branch_conflict as retryable (auto-cleanup)', () => {
    const autopsy = classifyTaskFailure({
      result: 'Error: branch auto/docs/123 already exists on remote',
    });

    expect(autopsy.kind).toBe('branch_conflict');
    expect(autopsy.retryable).toBe(true);
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
