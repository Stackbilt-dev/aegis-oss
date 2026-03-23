// ─── Exocortex v2: Memory Blocks ──────────────────────────────
// Always-visible structured state injected into executor prompts.
// Replaces scattered split-recall + CognitiveState self-model injection
// with priority-ordered, per-executor blocks.
//
// Design doc: artifacts/exocortex-v2-block-memory-design.md
// Issues: #204, #205, #206

import type { Executor } from '../types.js';

// ─── Block Types ──────────────────────────────────────────────

export type BlockId = 'identity' | 'operator_profile' | 'operating_rules' | 'active_context';

export interface MemoryBlock {
  id: BlockId;
  content: string;
  version: number;
  priority: number;
  max_bytes: number;
  updated_by: string;
  updated_at: string;
}

// ─── Per-Executor Attachment Config ──────────────────────────

const FULL_BLOCKS: readonly BlockId[] = ['identity', 'operator_profile', 'operating_rules', 'active_context'];
const MINIMAL_BLOCKS: readonly BlockId[] = ['identity'];
const CORE_BLOCKS: readonly BlockId[] = ['identity', 'operating_rules'];

const EXECUTOR_ATTACHMENTS: Record<Executor, readonly BlockId[]> = {
  claude:       FULL_BLOCKS,
  claude_opus:  FULL_BLOCKS,
  claude_code:  FULL_BLOCKS,
  composite:    FULL_BLOCKS,
  gpt_oss:      ['identity', 'operator_profile', 'operating_rules'],
  groq:         CORE_BLOCKS,
  workers_ai:   MINIMAL_BLOCKS,
  direct:       [],
  tarotscript:  [],
};

// ─── CRUD ────────────────────────────────────────────────────

export async function getBlock(db: D1Database, id: BlockId): Promise<MemoryBlock | null> {
  const row = await db.prepare(
    'SELECT id, content, version, priority, max_bytes, updated_by, updated_at FROM memory_blocks WHERE id = ?'
  ).bind(id).first<MemoryBlock>();
  return row ?? null;
}

export async function getAllBlocks(db: D1Database): Promise<MemoryBlock[]> {
  const { results } = await db.prepare(
    'SELECT id, content, version, priority, max_bytes, updated_by, updated_at FROM memory_blocks ORDER BY priority ASC'
  ).all<MemoryBlock>();
  return results;
}

export async function getAttachedBlocks(db: D1Database, executor: Executor): Promise<MemoryBlock[]> {
  const attachments = EXECUTOR_ATTACHMENTS[executor] ?? FULL_BLOCKS;
  if (attachments.length === 0) return [];

  const all = await getAllBlocks(db);
  const attachSet = new Set<string>(attachments);
  return all.filter(b => attachSet.has(b.id));
}

export async function updateBlock(
  db: D1Database,
  id: BlockId,
  content: string,
  updatedBy: string,
): Promise<{ version: number }> {
  // Enforce size limit
  const existing = await getBlock(db, id);
  if (!existing) throw new Error(`Block not found: ${id}`);

  const bytes = new TextEncoder().encode(content).length;
  if (bytes > existing.max_bytes) {
    throw new Error(`Block ${id} content (${bytes}B) exceeds max (${existing.max_bytes}B)`);
  }

  const newVersion = existing.version + 1;
  await db.prepare(
    `UPDATE memory_blocks SET content = ?, version = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(content, newVersion, updatedBy, id).run();

  return { version: newVersion };
}

// ─── Prompt Assembly ────────────────────────────────────────

const TOKEN_ESTIMATE_RATIO = 3.5; // chars per token

export function assembleBlockContext(blocks: MemoryBlock[], budgetTokens?: number): string {
  if (blocks.length === 0) return '';

  // Blocks arrive sorted by priority (lowest number = highest priority)
  if (!budgetTokens) {
    return blocks.map(b => b.content).join('\n\n');
  }

  let usedChars = 0;
  const budgetChars = budgetTokens * TOKEN_ESTIMATE_RATIO;
  const included: string[] = [];

  for (const block of blocks) {
    const chars = block.content.length;
    if (usedChars + chars > budgetChars) break;
    included.push(block.content);
    usedChars += chars;
  }

  return included.join('\n\n');
}

// ─── Seed Blocks ────────────────────────────────────────────
// One-time seed for fresh deployments or migration from split-recall.

export interface BlockSeed {
  id: BlockId;
  content: string;
  priority: number;
  max_bytes: number;
}

export const DEFAULT_SEEDS: BlockSeed[] = [
  {
    id: 'identity',
    priority: 1,
    max_bytes: 1024,
    content: `You are AEGIS — the operator's AI co-founder and autonomous agent.
Personality: pragmatic senior technical co-founder — direct, systems-thinking, no corporate fluff.
You are general-purpose. BizOps is one capability, not your ceiling. You research, analyze, plan, build, and ship.`,
  },
  {
    id: 'operator_profile',
    priority: 2,
    max_bytes: 2048,
    content: `## cognitive_style
- Prefers systems thinking — connects decisions to architectural consequences
- Values directness — skip the preamble, lead with the answer
- Thinks in portfolios — every product decision considered against the whole

## delegation
- Trusts autonomous execution for docs, tests, research
- Wants confirmation before production deploys and destructive ops
- Approves via shorthand: "do it", "ship it", "looks good"

## domain_knowledge
- Deep Cloudflare Workers expertise — D1, KV, Durable Objects, Queues, Service Bindings
- Building AI tooling portfolio — MCP, agent frameworks, headless image gen
- Bootstrap founder — no VC, revenue-first thinking, solo operator + AI co-founder model`,
  },
  {
    id: 'operating_rules',
    priority: 3,
    max_bytes: 1536,
    content: `- Record important facts to memory. Manage the agenda. Flag issues proactively.
- Think like an operator, not a consultant. Give the answer first, then reasoning.
- Never give generic advice when specific product context applies.
- Agenda is operator scratchpad only — work items flow through GitHub Issues.
- If something is on fire, say it's on fire.
- Be proactive — if you notice something during a task, flag it.
- Propose actions with consequences via [PROPOSED ACTION] agenda items. Just do routine read-only work.`,
  },
  {
    id: 'active_context',
    priority: 4,
    max_bytes: 3072,
    content: `## Operational Pulse
- Awaiting first consolidation cycle to populate this block.`,
  },
];

export async function seedBlocks(db: D1Database): Promise<number> {
  let seeded = 0;
  for (const seed of DEFAULT_SEEDS) {
    const existing = await db.prepare('SELECT id FROM memory_blocks WHERE id = ?').bind(seed.id).first();
    if (existing) continue;

    await db.prepare(
      `INSERT INTO memory_blocks (id, content, priority, max_bytes, updated_by) VALUES (?, ?, ?, ?, 'operator')`
    ).bind(seed.id, seed.content, seed.priority, seed.max_bytes).run();
    seeded++;
  }
  return seeded;
}
