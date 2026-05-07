// Fabrication detector post-pass for aegis_chat responses.
//
// v1 (aegis#447) — mutation-claim class. Scans for present-tense mutation
// language about agenda items and verifies each against D1 via the
// #448 helpers. Closes the Chimera failure mode (LLM narrates "resolved #N"
// while the item is still active).
//
// v2 (aegis#500) — referential-claim class. Scans for code-fenced slug-shaped
// strings asserted as canonical wiki pages and verifies each against the wiki.
// Note: pattern_id verification is omitted in this core layer (the convergence
// catalog is daemon/Stackbilt-specific); pattern_id claims are silently skipped.
//
// v1 follow-up 1 (aegis#447) — task mutation detection. Scans for UUID-quoted
// task state claims and verifies each against the cc_tasks D1 table.
//
// Shared scope posture for all passes:
// - Flag, don't strip. Operators see `unverified_claims[]` in the envelope.
// - Non-fatal on verification error. A single slug lookup failure does not
//   block the other claims from being reported.

import type { WikiClientEnv } from '../../wiki/client.js';
import { verifyAgendaClaim, verifyTaskClaim, verifyWikiPageClaim } from './verify.js';

export interface AgendaMutationClaim {
  kind: 'agenda';
  id: number;
  claimedStatus: 'resolved' | 'created' | 'dismissed';
  snippet: string;
}

export interface TaskMutationClaim {
  kind: 'task';
  id: string;
  claimedStatus: 'created' | 'completed' | 'cancelled' | 'running';
  snippet: string;
}

export type MutationClaim = AgendaMutationClaim | TaskMutationClaim;

export interface ReferentialClaim {
  kind: 'wiki_page' | 'pattern_id';
  reference: string;
  snippet: string;
}

export interface UnverifiedAgendaMutationClaim {
  kind: 'agenda';
  id: number;
  claimedStatus: AgendaMutationClaim['claimedStatus'];
  actualStatus: string | null;
  snippet: string;
  reason: 'status_mismatch' | 'not_found';
}

export interface UnverifiedTaskMutationClaim {
  kind: 'task';
  id: string;
  claimedStatus: TaskMutationClaim['claimedStatus'];
  actualStatus: string | null;
  snippet: string;
  reason: 'status_mismatch' | 'not_found';
}

export type UnverifiedMutationClaim =
  | UnverifiedAgendaMutationClaim
  | UnverifiedTaskMutationClaim;

export interface UnverifiedReferentialClaim {
  kind: ReferentialClaim['kind'];
  reference: string;
  snippet: string;
  reason: 'not_found';
}

export type UnverifiedClaim = UnverifiedMutationClaim | UnverifiedReferentialClaim;

// ─── Detection ─────────────────────────────────────────────────────

interface AgendaPattern {
  re: RegExp;
  status: AgendaMutationClaim['claimedStatus'];
}

const AGENDA_PATTERNS: AgendaPattern[] = [
  { re: /marked\s+#(\d+)\s+(?:as\s+)?resolved/gi, status: 'resolved' },
  { re: /#(\d+)\s+marked\s+(?:as\s+)?resolved/gi, status: 'resolved' },
  { re: /(?:^|[.\s])resolved\s+#(\d+)/gi, status: 'resolved' },
  { re: /#(\d+)\s+is\s+(?:now\s+)?resolved/gi, status: 'resolved' },
  { re: /(?:^|[.\s])closed\s+#(\d+)/gi, status: 'resolved' },
  { re: /#(\d+)\s+is\s+(?:now\s+)?closed/gi, status: 'resolved' },
  { re: /created\s+(?:agenda\s+item\s+)?#(\d+)/gi, status: 'created' },
  { re: /added\s+(?:agenda\s+item\s+)?#(\d+)/gi, status: 'created' },
  { re: /dismissed\s+#(\d+)/gi, status: 'dismissed' },
  { re: /#(\d+)\s+is\s+(?:now\s+)?dismissed/gi, status: 'dismissed' },
];

interface TaskPattern {
  re: RegExp;
  status: TaskMutationClaim['claimedStatus'];
}

const UUID_FRAG = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const TASK_PATTERNS: TaskPattern[] = [
  { re: new RegExp(`(?:created|queued|added)\\s+task\\s+\`?(${UUID_FRAG})\`?`, 'gi'), status: 'created' },
  { re: new RegExp(`completed\\s+task\\s+\`?(${UUID_FRAG})\`?`, 'gi'), status: 'completed' },
  { re: new RegExp(`marked\\s+task\\s+\`?(${UUID_FRAG})\`?\\s+(?:as\\s+)?completed`, 'gi'), status: 'completed' },
  { re: new RegExp(`task\\s+\`?(${UUID_FRAG})\`?\\s+(?:is|has)\\s+(?:now\\s+|been\\s+)?completed`, 'gi'), status: 'completed' },
  { re: new RegExp(`cancell?ed\\s+task\\s+\`?(${UUID_FRAG})\`?`, 'gi'), status: 'cancelled' },
  { re: new RegExp(`task\\s+\`?(${UUID_FRAG})\`?\\s+(?:is|was)\\s+(?:now\\s+)?cancell?ed`, 'gi'), status: 'cancelled' },
  { re: new RegExp(`task\\s+\`?(${UUID_FRAG})\`?\\s+is\\s+(?:now\\s+)?running`, 'gi'), status: 'running' },
];

export function detectMutationClaims(text: string): MutationClaim[] {
  const claims: MutationClaim[] = [];
  const seen = new Set<string>();

  for (const { re, status } of AGENDA_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = Number(m[1]);
      if (!Number.isInteger(id) || id < 1 || id > 1e9) continue;
      const key = `agenda:${id}:${status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const startContext = Math.max(0, (m.index ?? 0) - 30);
      const endContext = Math.min(text.length, (m.index ?? 0) + m[0].length + 30);
      const snippet = text.slice(startContext, endContext).replace(/\s+/g, ' ').trim();
      claims.push({ kind: 'agenda', id, claimedStatus: status, snippet });
    }
  }

  for (const { re, status } of TASK_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = m[1].toLowerCase();
      const key = `task:${id}:${status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const startContext = Math.max(0, (m.index ?? 0) - 30);
      const endContext = Math.min(text.length, (m.index ?? 0) + m[0].length + 30);
      const snippet = text.slice(startContext, endContext).replace(/\s+/g, ' ').trim();
      claims.push({ kind: 'task', id, claimedStatus: status, snippet });
    }
  }

  return claims;
}

// ─── Referential-claim detection (aegis#500 v2) ────────────────────

const SLUG_RE = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g;
const PATTERN_KEYWORD_RE = /\bpatterns?\b/i;
const WIKI_KEYWORD_RE = /\b(?:canonical|wiki[\s-]page|wiki[\s-]concept|concepts?\s+page|canonical[\s-]page)\b/i;
const MAX_REFERENTIAL_CLAIMS = 10;

function sentenceStartBefore(text: string, idx: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    const c = text[i];
    if ((c === '.' || c === '!' || c === '?') && i + 1 < text.length && /\s/.test(text[i + 1])) {
      return i + 2;
    }
  }
  return 0;
}

export function detectReferentialClaims(text: string): ReferentialClaim[] {
  const claims: ReferentialClaim[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(SLUG_RE)) {
    if (claims.length >= MAX_REFERENTIAL_CLAIMS) break;
    const slug = m[1];
    const matchIndex = m.index ?? 0;
    const sentenceStart = sentenceStartBefore(text, matchIndex);
    const window = text.slice(sentenceStart, matchIndex);

    const isPattern = PATTERN_KEYWORD_RE.test(window);
    const isWiki = WIKI_KEYWORD_RE.test(window);
    if (!isPattern && !isWiki) continue;

    const kind: ReferentialClaim['kind'] = isPattern ? 'pattern_id' : 'wiki_page';
    const key = `${kind}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const snippetStart = Math.max(0, matchIndex - 30);
    const snippetEnd = Math.min(text.length, matchIndex + m[0].length + 30);
    const snippet = text.slice(snippetStart, snippetEnd).replace(/\s+/g, ' ').trim();

    claims.push({ kind, reference: slug, snippet });
  }

  return claims;
}

// ─── Verification ──────────────────────────────────────────────────

export interface FabricationReport {
  checked: number;
  unverified: UnverifiedClaim[];
}

export async function verifyMutationClaims(
  claims: MutationClaim[],
  db: D1Database,
): Promise<FabricationReport> {
  const unverified: UnverifiedClaim[] = [];

  for (const claim of claims) {
    try {
      if (claim.kind === 'agenda') {
        const unv = await verifyAgendaMutation(db, claim);
        if (unv) unverified.push(unv);
      } else if (claim.kind === 'task') {
        const unv = await verifyTaskMutation(db, claim);
        if (unv) unverified.push(unv);
      }
    } catch {
      // Verification failure is non-fatal — skip this claim rather than
      // block the entire response.
    }
  }

  return { checked: claims.length, unverified };
}

async function verifyAgendaMutation(
  db: D1Database,
  claim: AgendaMutationClaim,
): Promise<UnverifiedAgendaMutationClaim | null> {
  const r = await verifyAgendaClaim(db, claim.id);
  if (!r.exists) {
    return {
      kind: 'agenda',
      id: claim.id,
      claimedStatus: claim.claimedStatus,
      actualStatus: null,
      snippet: claim.snippet,
      reason: 'not_found',
    };
  }
  const actualStatus = r.item?.status;
  const mismatch =
    (claim.claimedStatus === 'resolved' || claim.claimedStatus === 'dismissed') &&
    actualStatus === 'active';
  if (mismatch) {
    return {
      kind: 'agenda',
      id: claim.id,
      claimedStatus: claim.claimedStatus,
      actualStatus: actualStatus ?? null,
      snippet: claim.snippet,
      reason: 'status_mismatch',
    };
  }
  return null;
}

async function verifyTaskMutation(
  db: D1Database,
  claim: TaskMutationClaim,
): Promise<UnverifiedTaskMutationClaim | null> {
  const r = await verifyTaskClaim(db, claim.id);
  if (!r.exists) {
    return {
      kind: 'task',
      id: claim.id,
      claimedStatus: claim.claimedStatus,
      actualStatus: null,
      snippet: claim.snippet,
      reason: 'not_found',
    };
  }
  const actualStatus = r.task?.status;
  let mismatch = false;
  if (claim.claimedStatus === 'completed') {
    mismatch = actualStatus !== 'completed';
  } else if (claim.claimedStatus === 'cancelled') {
    mismatch = actualStatus !== 'cancelled';
  } else if (claim.claimedStatus === 'running') {
    mismatch = actualStatus !== 'running';
  }
  if (mismatch) {
    return {
      kind: 'task',
      id: claim.id,
      claimedStatus: claim.claimedStatus,
      actualStatus: actualStatus ?? null,
      snippet: claim.snippet,
      reason: 'status_mismatch',
    };
  }
  return null;
}

export async function verifyReferentialClaims(
  claims: ReferentialClaim[],
  env: WikiClientEnv,
): Promise<FabricationReport> {
  const unverified: UnverifiedClaim[] = [];

  for (const claim of claims) {
    try {
      if (claim.kind === 'pattern_id') {
        // Pattern catalog is daemon/consumer-specific; skip verification in core.
        continue;
      }

      // kind === 'wiki_page' — needs a live check. Skip silently if no binding.
      if (!env.wikiBinding || !env.wikiToken) continue;
      const r = await verifyWikiPageClaim(env, claim.reference);
      if (!r.exists) {
        unverified.push({
          kind: 'wiki_page',
          reference: claim.reference,
          snippet: claim.snippet,
          reason: 'not_found',
        });
      }
    } catch {
      // Non-fatal per v1 posture.
    }
  }

  return { checked: claims.length, unverified };
}

// ─── Full post-pass ────────────────────────────────────────────────

export interface FabricationCheckEnv extends WikiClientEnv {
  db: D1Database;
}

export async function fabricationCheck(
  responseText: string,
  env: FabricationCheckEnv,
): Promise<FabricationReport> {
  const mutationClaims = detectMutationClaims(responseText);
  const referentialClaims = detectReferentialClaims(responseText);

  if (mutationClaims.length === 0 && referentialClaims.length === 0) {
    return { checked: 0, unverified: [] };
  }

  const [mutationReport, referentialReport] = await Promise.all([
    mutationClaims.length ? verifyMutationClaims(mutationClaims, env.db) : Promise.resolve<FabricationReport>({ checked: 0, unverified: [] }),
    referentialClaims.length ? verifyReferentialClaims(referentialClaims, env) : Promise.resolve<FabricationReport>({ checked: 0, unverified: [] }),
  ]);

  return {
    checked: mutationReport.checked + referentialReport.checked,
    unverified: [...mutationReport.unverified, ...referentialReport.unverified],
  };
}

// ─── Envelope format ───────────────────────────────────────────────

export function formatUnverifiedClaims(report: FabricationReport): string[] {
  return report.unverified.map((u) => {
    if (u.kind === 'agenda') {
      if (u.reason === 'not_found') {
        return `agenda#${u.id} (claimed ${u.claimedStatus}, but item does not exist)`;
      }
      return `agenda#${u.id} (claimed ${u.claimedStatus}, actual status: ${u.actualStatus})`;
    }
    if (u.kind === 'task') {
      if (u.reason === 'not_found') {
        return `task \`${u.id}\` (claimed ${u.claimedStatus}, but task does not exist)`;
      }
      return `task \`${u.id}\` (claimed ${u.claimedStatus}, actual status: ${u.actualStatus})`;
    }
    if (u.kind === 'wiki_page') {
      return `wiki page \`${u.reference}\` (claimed canonical, but no such page exists)`;
    }
    // pattern_id — not verified in core, included for type completeness
    return `pattern \`${u.reference}\` (claimed canonical, not in convergence catalog)`;
  });
}
