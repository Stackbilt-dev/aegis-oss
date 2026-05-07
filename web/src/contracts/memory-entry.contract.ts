import { z } from 'zod';
import { defineContract } from '@stackbilt/contracts';

const ValidationStage = z.enum(['candidate', 'validated', 'expert', 'canonical', 'refuted']);

export const MemoryEntryContract = defineContract({
  name: 'MemoryEntry',
  version: '1.0.0',
  description: 'Semantic memory entry with topic-scoped facts, CRIX validation pipeline, and decay tracking',

  schema: z.object({
    id: z.number().int().positive(),
    topic: z.string().min(1),
    fact: z.string().min(1),
    factHash: z.string().default(''),
    confidence: z.number().min(0).max(1).default(0.8),
    source: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    validUntil: z.string().datetime().nullable(),
    supersededBy: z.number().int().positive().nullable(),
    strength: z.number().int().nonnegative().default(1),
    lastRecalledAt: z.string().datetime().nullable(),
    validationStage: ValidationStage.default('candidate'),
    validators: z.string().nullable(),
  }),

  operations: {
    record: {
      input: z.object({
        topic: z.string().min(1),
        fact: z.string().min(1),
        source: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
        expiresAt: z.string().datetime().optional(),
      }),
      output: 'self' as const,
      emits: ['memory_entry.recorded'],
    },

    validate: {
      input: z.object({
        id: z.number().int().positive(),
        repo: z.string().min(1),
        confirmed: z.boolean(),
        date: z.string().datetime(),
      }),
      output: 'self' as const,
      transition: { from: 'candidate', to: 'validated' },
      emits: ['memory_entry.validated'],
    },

    promoteToExpert: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      transition: { from: 'validated', to: 'expert' },
      emits: ['memory_entry.promoted_expert'],
    },

    promoteToCanonical: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      transition: { from: 'expert', to: 'canonical' },
      emits: ['memory_entry.promoted_canonical'],
    },

    refute: {
      input: z.object({
        id: z.number().int().positive(),
        supersededBy: z.number().int().positive().optional(),
      }),
      output: 'self' as const,
      transition: { from: ['candidate', 'validated', 'expert'], to: 'refuted' },
      emits: ['memory_entry.refuted'],
    },

    recall: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      emits: ['memory_entry.recalled'],
    },

    expire: {
      input: z.object({ id: z.number().int().positive() }),
      output: 'self' as const,
      emits: ['memory_entry.expired'],
    },
  },

  states: {
    field: 'validationStage',
    initial: 'candidate',
    transitions: {
      candidate: {
        validate: 'validated',
        refute: 'refuted',
      },
      validated: {
        promoteToExpert: 'expert',
        refute: 'refuted',
      },
      expert: {
        promoteToCanonical: 'canonical',
        refute: 'refuted',
      },
      canonical: {},
      refuted: {},
    },
  },

  surfaces: {
    api: {
      basePath: '/api/memory',
      routes: {
        record: { method: 'POST', path: '/' },
        validate: { method: 'POST', path: '/:id/validate' },
        promoteToExpert: { method: 'POST', path: '/:id/promote-expert' },
        promoteToCanonical: { method: 'POST', path: '/:id/promote-canonical' },
        refute: { method: 'POST', path: '/:id/refute' },
        recall: { method: 'POST', path: '/:id/recall' },
        expire: { method: 'POST', path: '/:id/expire' },
      },
    },
    db: {
      table: 'memory_entries',
      indexes: [
        'idx_memory_topic(topic)',
        'idx_memory_dedup(topic, fact_hash)',
        'idx_memory_expires(expires_at)',
        'idx_memory_valid(valid_until)',
        'idx_memory_validation_stage(validation_stage)',
      ],
      columnOverrides: {
        createdAt: { default: "datetime('now')" },
        updatedAt: { default: "datetime('now')" },
      },
    },
  },

  authority: {
    record: { requires: 'role', roles: ['operator', 'system'] },
    validate: { requires: 'role', roles: ['system'] },
    promoteToExpert: { requires: 'role', roles: ['system'] },
    promoteToCanonical: { requires: 'role', roles: ['system'] },
    refute: { requires: 'role', roles: ['operator', 'system'] },
    recall: { requires: 'role', roles: ['system'] },
    expire: { requires: 'role', roles: ['system'] },
  },

  invariants: [
    {
      name: 'refuted_entry_not_canonical',
      description: 'Canonical entries cannot be refuted — they must be superseded instead',
      check: (entity: unknown) => {
        const m = entity as { validationStage?: string };
        if (m.validationStage === 'canonical') {
          return 'Canonical entries cannot transition to refuted';
        }
        return true;
      },
      appliesTo: ['refute'],
    },
    {
      name: 'high_confidence_for_canonical',
      description: 'Canonical entries should have confidence >= 0.9',
      check: (entity: unknown) => {
        const m = entity as { validationStage?: string; confidence?: number };
        if (m.validationStage === 'canonical' && (m.confidence ?? 0) < 0.9) {
          return 'Canonical memory entries require confidence >= 0.9';
        }
        return true;
      },
      appliesTo: ['promoteToCanonical'],
    },
  ],
});
