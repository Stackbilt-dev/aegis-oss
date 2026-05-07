// Grounding fanout — extracts named entities from a raw intent, runs parallel
// retrieval against D1 (agenda/task claims) and the wiki, assembles a structured
// grounding block, and returns it to the caller for prompt injection.
//
// Decision-entity fanout (BizOps) is omitted from this generic core layer.
// Consumers that need it should compose at the call site.

import { searchPages } from '../../wiki/client.js';
import type { WikiClientEnv } from '../../wiki/client.js';
import { verifyAgendaClaim, verifyTaskClaim } from './verify.js';
import type { AgendaClaimResult, TaskClaimResult } from './verify.js';

export interface ExtractedEntities {
  agendaRefs: number[];
  taskRefs: string[];
  namedEntities: string[];
}

export interface GroundingResult {
  entities: ExtractedEntities;
  agendaHits: Array<{ id: number; status: 'verified' | 'unknown'; item?: AgendaClaimResult['item'] }>;
  taskHits: Array<{ id: string; status: 'verified' | 'unknown'; task?: TaskClaimResult['task'] }>;
  wikiHits: Array<{ slug: string; scope?: string; summary?: string }>;
  searched: string[];
}

// ─── Entity extraction ─────────────────────────────────────────────

const AGENDA_REF_RE = /(?:^|\s|\()#(\d+)(?=\b)/g;
const TASK_REF_RE = /(?:^|\s|\()task[:_\s-]?([A-Za-z0-9-]{8,})/gi;
const ORG_REPO_RE = /\b([A-Za-z][\w-]{2,})\/([A-Za-z][\w.-]{2,})\b/g;
const QUOTED_RE = /"([^"\n]{3,60})"/g;

const STOP_TOKENS = new Set([
  'it', 'that', 'this', 'the', 'our', 'your', 'their', 'a', 'an',
  'what', 'which', 'who', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'do', 'does', 'did',
]);

export function extractEntities(raw: string): ExtractedEntities {
  const agendaRefs = new Set<number>();
  const taskRefs = new Set<string>();
  const named = new Set<string>();

  for (const m of raw.matchAll(AGENDA_REF_RE)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0 && n < 1e9) agendaRefs.add(n);
  }

  for (const m of raw.matchAll(TASK_REF_RE)) {
    const id = m[1];
    if (id && id.length >= 8 && id.length <= 64) taskRefs.add(id);
  }

  for (const m of raw.matchAll(ORG_REPO_RE)) {
    const org = m[1];
    if (!STOP_TOKENS.has(org.toLowerCase())) {
      named.add(`${m[1]}/${m[2]}`);
    }
  }

  for (const m of raw.matchAll(QUOTED_RE)) {
    const phrase = m[1].trim();
    if (phrase.length >= 3) named.add(phrase);
  }

  return {
    agendaRefs: [...agendaRefs],
    taskRefs: [...taskRefs],
    namedEntities: [...named],
  };
}

// ─── Fanout ────────────────────────────────────────────────────────

export interface GroundingFanoutEnv {
  db: D1Database;
  wiki?: WikiClientEnv;
}

export async function groundIntent(
  raw: string,
  env: GroundingFanoutEnv,
): Promise<GroundingResult> {
  const entities = extractEntities(raw);
  const searched: string[] = [];

  const agendaPromise = (async () => {
    if (entities.agendaRefs.length === 0) return [];
    searched.push('d1.agenda');
    const results = await Promise.all(
      entities.agendaRefs.map(async (id) => {
        try {
          const r = await verifyAgendaClaim(env.db, id);
          return r.exists
            ? { id, status: 'verified' as const, item: r.item }
            : { id, status: 'unknown' as const };
        } catch {
          return { id, status: 'unknown' as const };
        }
      }),
    );
    return results;
  })();

  const taskPromise = (async () => {
    if (entities.taskRefs.length === 0) return [];
    searched.push('d1.tasks');
    const results = await Promise.all(
      entities.taskRefs.map(async (id) => {
        try {
          const r = await verifyTaskClaim(env.db, id);
          return r.exists
            ? { id, status: 'verified' as const, task: r.task }
            : { id, status: 'unknown' as const };
        } catch {
          return { id, status: 'unknown' as const };
        }
      }),
    );
    return results;
  })();

  const wikiPromise = (async () => {
    if (!env.wiki || entities.namedEntities.length === 0) return [];
    searched.push('wiki');
    const hits: GroundingResult['wikiHits'] = [];
    for (const entity of entities.namedEntities.slice(0, 5)) {
      try {
        const { results } = await searchPages(env.wiki, entity, { limit: 3 });
        for (const r of results) {
          hits.push({ slug: r.slug, scope: r.scope, summary: r.summary });
        }
      } catch {
        // non-fatal per-entity
      }
    }
    // Dedupe by slug
    const seen = new Set<string>();
    return hits.filter((h) => {
      if (seen.has(h.slug)) return false;
      seen.add(h.slug);
      return true;
    });
  })();

  const [agendaHits, taskHits, wikiHits] = await Promise.all([
    agendaPromise,
    taskPromise,
    wikiPromise,
  ]);

  return { entities, agendaHits, taskHits, wikiHits, searched };
}

// ─── Envelope summary ──────────────────────────────────────────────

export interface GroundingEnvelope {
  grounded: boolean;
  sources: string[];
  unknowns: string[];
  searched: string[];
}

export function summarizeGrounding(result: GroundingResult): GroundingEnvelope {
  const sources: string[] = [];
  const unknowns: string[] = [];

  for (const h of result.agendaHits) {
    if (h.status === 'verified') sources.push(`d1:agenda/${h.id}`);
    else unknowns.push(`agenda#${h.id}`);
  }
  for (const h of result.taskHits) {
    if (h.status === 'verified') sources.push(`d1:task/${h.id}`);
    else unknowns.push(`task:${h.id}`);
  }
  for (const h of result.wikiHits) {
    sources.push(`wiki:${h.scope ? `${h.scope}/` : ''}${h.slug}`);
  }

  return {
    grounded: sources.length > 0,
    sources,
    unknowns,
    searched: [...result.searched],
  };
}

export function formatGroundingBlock(result: GroundingResult): string | null {
  const hasContent =
    result.agendaHits.length > 0 ||
    result.taskHits.length > 0 ||
    result.wikiHits.length > 0;
  if (!hasContent) return null;

  const lines: string[] = ['[Grounding — verified facts for entities in this query]'];

  if (result.agendaHits.length > 0) {
    lines.push('');
    lines.push('Agenda items:');
    for (const h of result.agendaHits) {
      if (h.status === 'verified' && h.item) {
        lines.push(
          `  #${h.id} — ${h.item.item} (status: ${h.item.status}, priority: ${h.item.priority}${h.item.resolved_at ? `, resolved ${h.item.resolved_at}` : ''})`,
        );
      } else {
        lines.push(`  #${h.id} — UNKNOWN: no such agenda item exists in D1.`);
      }
    }
  }

  if (result.taskHits.length > 0) {
    lines.push('');
    lines.push('Tasks:');
    for (const h of result.taskHits) {
      if (h.status === 'verified' && h.task) {
        lines.push(
          `  ${h.id} — ${h.task.title} (status: ${h.task.status}${h.task.completed_at ? `, completed ${h.task.completed_at}` : ''})`,
        );
      } else {
        lines.push(`  ${h.id} — UNKNOWN: no such task exists in D1.`);
      }
    }
  }

  if (result.wikiHits.length > 0) {
    lines.push('');
    lines.push('Related wiki pages:');
    for (const h of result.wikiHits.slice(0, 8)) {
      const summary = h.summary ? ` — ${h.summary.slice(0, 140)}` : '';
      lines.push(`  ${h.scope ? `${h.scope}/` : ''}${h.slug}${summary}`);
    }
  }

  lines.push('');
  lines.push(
    '[Instruction: For any entity marked UNKNOWN above, respond "I have no record of X" and do not invent details. Treat verified entries as authoritative; cite wiki pages by slug when used.]',
  );
  return lines.join('\n');
}
