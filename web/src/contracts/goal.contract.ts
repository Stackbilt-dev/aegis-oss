import { z } from 'zod';
import { defineContract } from '@stackbilt/contracts';

const GoalStatus = z.enum(['active', 'paused', 'completed', 'failed']);
const AuthorityLevel = z.enum(['propose', 'auto_low', 'auto_high']);

export const GoalContract = defineContract({
  name: 'Goal',
  version: '1.0.0',
  description: 'Autonomous agent goal with scheduled execution and authority-gated autonomy',

  schema: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable(),
    status: GoalStatus.default('active'),
    authorityLevel: AuthorityLevel.default('propose'),
    scheduleHours: z.number().int().positive().default(6),
    createdAt: z.string().datetime(),
    lastRunAt: z.string().datetime().nullable(),
    nextRunAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    runCount: z.number().int().nonnegative().default(0),
    contextJson: z.string().nullable(),
    businessUnit: z.string().min(1).default('stackbilt'),
  }),

  operations: {
    create: {
      input: z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        authorityLevel: AuthorityLevel.optional(),
        scheduleHours: z.number().int().positive().optional(),
        contextJson: z.string().optional(),
        businessUnit: z.string().min(1).optional(),
      }),
      output: 'self' as const,
      emits: ['goal.created'],
    },

    pause: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      transition: { from: 'active', to: 'paused' },
      emits: ['goal.paused'],
    },

    resume: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      transition: { from: 'paused', to: 'active' },
      emits: ['goal.resumed'],
    },

    complete: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      transition: { from: ['active', 'paused'], to: 'completed' },
      emits: ['goal.completed'],
    },

    fail: {
      input: z.object({ id: z.string().min(1) }),
      output: 'self' as const,
      transition: { from: ['active', 'paused'], to: 'failed' },
      emits: ['goal.failed'],
    },

    recordRun: {
      input: z.object({
        id: z.string().min(1),
        nextRunAt: z.string().datetime().optional(),
      }),
      output: 'self' as const,
      emits: ['goal.ran'],
    },
  },

  states: {
    field: 'status',
    initial: 'active',
    transitions: {
      active: {
        pause: 'paused',
        complete: 'completed',
        fail: 'failed',
      },
      paused: {
        resume: 'active',
        complete: 'completed',
        fail: 'failed',
      },
      completed: {},
      failed: {},
    },
  },

  surfaces: {
    api: {
      basePath: '/api/goals',
      routes: {
        create: { method: 'POST', path: '/' },
        pause: { method: 'POST', path: '/:id/pause' },
        resume: { method: 'POST', path: '/:id/resume' },
        complete: { method: 'POST', path: '/:id/complete' },
        fail: { method: 'POST', path: '/:id/fail' },
      },
    },
    db: {
      table: 'agent_goals',
      indexes: [
        'idx_goals_status(status)',
        'idx_goals_next_run(next_run_at)',
        'idx_goals_bu(business_unit, status)',
      ],
      columnOverrides: {
        createdAt: { default: "datetime('now')" },
      },
    },
  },

  authority: {
    create: { requires: 'role', roles: ['operator', 'system'] },
    pause: { requires: 'role', roles: ['operator', 'system'] },
    resume: { requires: 'role', roles: ['operator', 'system'] },
    complete: { requires: 'role', roles: ['system'] },
    fail: { requires: 'role', roles: ['system'] },
    recordRun: { requires: 'role', roles: ['system'] },
  },

  invariants: [
    {
      name: 'completed_has_timestamp',
      description: 'Completed goals must have a completedAt timestamp',
      check: (entity: unknown) => {
        const g = entity as { status?: string; completedAt?: string | null };
        if (g.status === 'completed' && !g.completedAt) {
          return 'Completed goal requires completedAt';
        }
        return true;
      },
      appliesTo: ['complete'],
    },
  ],
});
