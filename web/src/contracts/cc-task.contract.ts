import { z } from 'zod';
import { defineContract } from '@stackbilt/contracts';

const TaskStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
const TaskAuthority = z.enum(['proposed', 'auto_safe', 'operator']);
const TaskCategory = z.enum(['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy']);

export const CCTaskContract = defineContract({
  name: 'CCTask',
  version: '1.0.0',
  description: 'Claude Code autonomous task — queued, governed, and executed by the task runner',

  schema: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    repo: z.string().min(1),
    prompt: z.string().min(1),
    completionSignal: z.string().nullable(),
    status: TaskStatus.default('pending'),
    priority: z.number().int().min(0).max(100).default(50),
    dependsOn: z.string().nullable(),
    blockedBy: z.string().nullable(),
    maxTurns: z.number().int().positive().default(25),
    allowedTools: z.string().nullable(),
    sessionId: z.string().nullable(),
    result: z.string().nullable(),
    error: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    preflightJson: z.string().nullable(),
    failureKind: z.string().nullable(),
    retryable: z.boolean().default(false),
    autopsyJson: z.string().nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    createdBy: z.string().min(1).default('operator'),
    authority: TaskAuthority.default('operator'),
    category: TaskCategory.default('feature'),
    branch: z.string().nullable(),
    prUrl: z.string().nullable(),
    utilityJson: z.string().nullable(),
    githubIssueRepo: z.string().nullable(),
    githubIssueNumber: z.number().int().positive().nullable(),
    businessUnit: z.string().min(1).default('stackbilt'),
  }),

  operations: {
    create: {
      input: z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        repo: z.string().min(1),
        prompt: z.string().min(1),
        completionSignal: z.string().optional(),
        priority: z.number().int().min(0).max(100).optional(),
        dependsOn: z.string().optional(),
        blockedBy: z.string().optional(),
        maxTurns: z.number().int().positive().optional(),
        allowedTools: z.string().optional(),
        authority: TaskAuthority.optional(),
        category: TaskCategory.optional(),
        githubIssueRepo: z.string().optional(),
        githubIssueNumber: z.number().int().positive().optional(),
        businessUnit: z.string().min(1).optional(),
      }),
      output: 'self' as const,
      emits: ['cc_task.created'],
    },

    start: {
      input: z.object({
        id: z.string().min(1),
        sessionId: z.string().min(1),
      }),
      output: 'self' as const,
      transition: { from: 'pending', to: 'running' },
      emits: ['cc_task.started'],
    },

    complete: {
      input: z.object({
        id: z.string().min(1),
        result: z.string().optional(),
        exitCode: z.number().int().optional(),
        prUrl: z.string().optional(),
        utilityJson: z.string().optional(),
      }),
      output: 'self' as const,
      transition: { from: 'running', to: 'completed' },
      emits: ['cc_task.completed'],
    },

    fail: {
      input: z.object({
        id: z.string().min(1),
        error: z.string().min(1),
        exitCode: z.number().int().optional(),
        failureKind: z.string().optional(),
        retryable: z.boolean().optional(),
        autopsyJson: z.string().optional(),
      }),
      output: 'self' as const,
      transition: { from: 'running', to: 'failed' },
      emits: ['cc_task.failed'],
    },

    cancel: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      transition: { from: ['pending', 'running'], to: 'cancelled' },
      emits: ['cc_task.cancelled'],
    },

    approve: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      emits: ['cc_task.approved'],
    },
  },

  states: {
    field: 'status',
    initial: 'pending',
    transitions: {
      pending: {
        start: 'running',
        cancel: 'cancelled',
      },
      running: {
        complete: 'completed',
        fail: 'failed',
        cancel: 'cancelled',
      },
      completed: {},
      failed: {},
      cancelled: {},
    },
  },

  surfaces: {
    api: {
      basePath: '/api/cc-tasks',
      routes: {
        create: { method: 'POST', path: '/' },
        start: { method: 'POST', path: '/:id/start' },
        complete: { method: 'POST', path: '/:id/complete' },
        fail: { method: 'POST', path: '/:id/fail' },
        cancel: { method: 'POST', path: '/:id/cancel' },
        approve: { method: 'POST', path: '/:id/approve' },
      },
    },
    db: {
      table: 'cc_tasks',
      indexes: [
        'idx_cc_tasks_status(status, priority)',
        'idx_cc_tasks_depends(depends_on)',
        'idx_cc_tasks_created(created_at)',
        'idx_cc_tasks_bu(business_unit, status)',
        'idx_cc_tasks_authority(authority)',
        'idx_cc_tasks_gh_issue(github_issue_repo, github_issue_number)',
        'idx_cc_tasks_failure_kind(failure_kind, completed_at)',
      ],
      columnOverrides: {
        createdAt: { default: "datetime('now')" },
      },
    },
  },

  authority: {
    create: { requires: 'role', roles: ['operator', 'system'] },
    start: { requires: 'role', roles: ['system'] },
    complete: { requires: 'role', roles: ['system'] },
    fail: { requires: 'role', roles: ['system'] },
    cancel: { requires: 'role', roles: ['operator', 'system'] },
    approve: { requires: 'role', roles: ['operator'] },
  },

  invariants: [
    {
      name: 'proposed_task_needs_approval',
      description: 'Proposed tasks must be approved before they can run',
      check: (entity: unknown) => {
        const t = entity as { authority?: string; status?: string };
        if (t.authority === 'proposed' && t.status === 'running') {
          return 'Proposed tasks require approval before execution';
        }
        return true;
      },
      appliesTo: ['start'],
    },
    {
      name: 'completed_has_timestamp',
      description: 'Completed or failed tasks must have a completedAt timestamp',
      check: (entity: unknown) => {
        const t = entity as { status?: string; completedAt?: string | null };
        if ((t.status === 'completed' || t.status === 'failed') && !t.completedAt) {
          return 'Terminal tasks require completedAt';
        }
        return true;
      },
      appliesTo: ['complete', 'fail'],
    },
  ],
});
