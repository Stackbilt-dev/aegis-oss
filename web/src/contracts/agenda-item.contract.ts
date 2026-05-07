import { z } from 'zod';
import { defineContract } from '@stackbilt/contracts';

const AgendaPriority = z.enum(['low', 'medium', 'high']);
const AgendaStatus = z.enum(['active', 'done', 'dismissed']);

export const AgendaItemContract = defineContract({
  name: 'AgendaItem',
  version: '1.0.0',
  description: 'Operator agenda item — work scratchpad with priority and lifecycle tracking',

  schema: z.object({
    id: z.number().int().positive(),
    item: z.string().min(1),
    context: z.string().nullable(),
    priority: AgendaPriority.default('medium'),
    status: AgendaStatus.default('active'),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    businessUnit: z.string().min(1).default('stackbilt'),
  }),

  operations: {
    add: {
      input: z.object({
        item: z.string().min(1),
        context: z.string().optional(),
        priority: AgendaPriority.optional(),
        businessUnit: z.string().min(1).optional(),
      }),
      output: 'self' as const,
      emits: ['agenda_item.added'],
    },

    resolve: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      transition: { from: 'active', to: 'done' },
      emits: ['agenda_item.resolved'],
    },

    dismiss: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      transition: { from: 'active', to: 'dismissed' },
      emits: ['agenda_item.dismissed'],
    },

    escalate: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      emits: ['agenda_item.escalated'],
    },
  },

  states: {
    field: 'status',
    initial: 'active',
    transitions: {
      active: {
        resolve: 'done',
        dismiss: 'dismissed',
      },
      done: {},
      dismissed: {},
    },
  },

  surfaces: {
    api: {
      basePath: '/api/agenda',
      routes: {
        add: { method: 'POST', path: '/' },
        resolve: { method: 'POST', path: '/:id/resolve' },
        dismiss: { method: 'POST', path: '/:id/dismiss' },
        escalate: { method: 'POST', path: '/:id/escalate' },
      },
    },
    db: {
      table: 'agent_agenda',
      indexes: [
        'idx_agenda_status(status)',
        'idx_agenda_priority(priority)',
        'idx_agenda_bu(business_unit, status)',
      ],
      columnOverrides: {
        createdAt: { default: "datetime('now')" },
      },
    },
  },

  authority: {
    add: { requires: 'role', roles: ['operator', 'system'] },
    resolve: { requires: 'role', roles: ['operator', 'system'] },
    dismiss: { requires: 'role', roles: ['operator', 'system'] },
    escalate: { requires: 'role', roles: ['system'] },
  },

  invariants: [
    {
      name: 'resolved_has_timestamp',
      description: 'Done items must have a resolvedAt timestamp',
      check: (entity: unknown) => {
        const a = entity as { status?: string; resolvedAt?: string | null };
        if (a.status === 'done' && !a.resolvedAt) {
          return 'Done agenda item requires resolvedAt';
        }
        return true;
      },
      appliesTo: ['resolve'],
    },
  ],
});
