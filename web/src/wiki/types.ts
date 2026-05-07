// Second source of truth vs emdash seed.json (stackbilt-emdash/seed/seed.json).
// Intentional: this is the client-side MCP validator gate — narrower-than-server
// is fail-closed (daemon rejects, surfaces loudly). Keep in sync with seed.json
// when extending. Auto-generation from the seed schema is a separate epic.
export const WIKI_SCOPES = ['aegis', 'concepts', 'entities', 'decisions', 'wiki', 'dreams', 'contracts'] as const;
export const WIKI_TYPES = ['state', 'architecture', 'decision', 'concept', 'entity', 'agenda', 'synthesis'] as const;
export const WIKI_CONFIDENCES = ['stable', 'drifting', 'unverified', 'contested'] as const;
export const WIKI_STATUSES = ['experimental', 'stable', 'deprecated'] as const;

export type WikiScope = typeof WIKI_SCOPES[number];
export type WikiType = typeof WIKI_TYPES[number];
export type WikiConfidence = typeof WIKI_CONFIDENCES[number];
export type WikiStatus = typeof WIKI_STATUSES[number];

export interface WikiSource {
  type: string;
  ref: string;
  verified_date: string;
}

export interface WriteInput {
  slug: string;
  scope: WikiScope;
  type: WikiType;
  title: string;
  summary: string;
  body: string;
  canonical?: boolean;
  confidence?: WikiConfidence;
  last_verified?: string;
  sources?: WikiSource[];
  related?: string[];
  supersedes?: string[];
  // Contracts-scope frontmatter (Nexus Gate A, aegis#523).
  // Required when scope === 'contracts'; enforced in mcp/handlers.ts.
  // `contract_status` disambiguates from emdash's built-in `status` content-
  // lifecycle column (draft/published/archived) which would collide.
  owners?: string[];
  consumers?: string[];
  guarded_paths?: string[];
  contract_status?: WikiStatus;
}

export interface PageSummary {
  slug: string;
  title: string;
  scope: string;
  type: string;
  confidence: string;
  summary: string;
  updated_at: string;
  snippet?: string;
}

export interface WikiPage extends PageSummary {
  id: string;
  status?: string;
  revision_id?: string;
  body?: string;
  canonical?: boolean;
  last_verified?: string;
  sources?: WikiSource[];
  related?: string[];
  supersedes?: string[];
  // Contracts-scope frontmatter (Nexus Gate A, aegis#523).
  owners?: string[];
  consumers?: string[];
  guarded_paths?: string[];
  [key: string]: unknown;
}

export interface ReadPageResult {
  page: WikiPage | null;
}

export interface SearchPagesResult {
  results: PageSummary[];
}

export interface WritePageResult {
  slug: string;
  id: string;
  revision_id?: string;
}

export interface ListPagesResult {
  pages: PageSummary[];
  total: number;
  nextCursor?: string;
}
