import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  AI: Ai;
  AEGIS_TOKEN: string;

  // OAuth 2.1 (injected by OAuthProvider wrapper at runtime)
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  AEGIS_ENV: string;

  // Anthropic (Claude executor)
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  CLAUDE_OPUS_MODEL: string;

  // GPT-OSS (standard executor — tool-capable, cheap)
  GPT_OSS_MODEL: string;

  // Groq (classification + greeting executor + composite orchestration)
  GROQ_API_KEY: string;
  GROQ_MODEL: string;
  GROQ_RESPONSE_MODEL: string;
  GROQ_GPT_OSS_MODEL: string;

  // AI Gateway (observability, caching, rate limiting)
  AI_GATEWAY_ID: string;

  // BizOps MCP — Service Binding (Worker-to-Worker)
  BIZOPS: Fetcher;
  BIZOPS_TOKEN: string;

  // Resend (proactive email alerts)
  RESEND_API_KEY: string;
  RESEND_API_KEY_PERSONAL: string;

  // GitHub (self-improvement analysis)
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;

  // Brave Search (web research)
  BRAVE_API_KEY: string;

  // Proactive notifications (Stage 2)
  AEGIS_NOTIFY_EMAIL: string;
  AEGIS_BASE_URL: string;

  // Roundtable content platform (shared D1 binding)
  ROUNDTABLE_DB: D1Database;

  // Cloudflare Observability (infrastructure monitoring)
  CF_ANALYTICS_TOKEN: string;

  // Image generation service (hero image generation via Service Binding)
  IMG_FORGE: Fetcher;
  IMG_FORGE_SB_SECRET: string;

  // Memory Worker (Service Binding RPC)
  MEMORY: MemoryServiceBinding;

  // TarotScript Worker (symbolic consultation via Service Binding)
  TAROTSCRIPT: Fetcher;

  // Colony OS MARA Governor (MCP via Service Binding)
  MARA: Fetcher;
  MARA_TOKEN: string;

  // CodeBeast (adversarial code review + fix drain via Service Binding)
  CODEBEAST: Fetcher;

  // MindSpring (semantic search over 2k+ Claude Code conversations via Service Binding)
  MINDSPRING: Fetcher;
  MINDSPRING_TOKEN: string;

  // dev.to syndication (cross-post blog content)
  DEVTO_API_KEY: string;

  // ElevenLabs voice funnel webhook secret (#99)
  ELEVENLABS_WEBHOOK_SECRET: string;

  // ARGUS: Webhook HMAC secrets for unified ingestion
  GITHUB_WEBHOOK_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Google Analytics Data API (OAuth2 refresh token flow)
  GA_CREDENTIALS: string; // JSON: { client_id, client_secret, refresh_token, property_id }
}

// ─── Memory Worker RPC interface (mirrors memory-worker MemoryService)
export interface MemoryServiceBinding {
  store(tenantId: string, fragments: MemoryStoreRequest[]): Promise<MemoryStoreResult>;
  recall(tenantId: string, query: MemoryRecallQuery): Promise<MemoryFragmentResult[]>;
  forget(tenantId: string, filter: MemoryForgetFilter): Promise<number>;
  decay(tenantId: string): Promise<{ decayed: number; pruned: number; promoted: number }>;
  consolidate(tenantId: string): Promise<{ processed: number; merged: number; pruned: number; high_water_mark: string }>;
  health(): Promise<{ status: string; version: string; tenants: number; total_fragments: number; active_fragments: number }>;
  stats(tenantId: string): Promise<MemoryStatsResult>;
  embed(tenantId: string, texts: string[]): Promise<{ embeddings: number[][] }>;
}

export interface MemoryStoreRequest {
  content: string;
  topic: string;
  confidence?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  lifecycle?: 'observed' | 'confirmed' | 'core' | 'archived';
  // CRIX insight metadata (all optional, mirrors Memory Worker StoreRequest)
  insight_type?: 'pattern' | 'bug_signature' | 'perf_win' | 'arch_improvement' | 'gotcha';
  origin_repo?: string;
  origin_commit?: string;
  applicable_repos?: string[];
  applicability_confidence?: number;
  keywords?: string[];
  cross_repo_impact?: 'unknown' | 'confirmed' | 'tested' | 'deployed';
}

export interface MemoryStoreResult {
  stored: number;
  merged: number;
  duplicates: number;
  fragment_ids: string[];
}

export interface MemoryRecallQuery {
  id?: string;
  topic?: string;
  topics?: string[];
  keywords?: string;
  lifecycle?: Array<'observed' | 'confirmed' | 'core' | 'archived'>;
  min_confidence?: number;
  limit?: number;
  include_archived?: boolean;
}

export interface MemoryFragmentResult {
  id: string;
  tenant_id: string;
  content: string;
  topic: string;
  confidence: number;
  lifecycle: string;
  strength: number;
  last_accessed_at: string;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryForgetFilter {
  ids?: string[];
  topic?: string;
  before?: string;
  min_confidence_below?: number;
  hard_delete?: boolean;
}

export interface MemoryStatsResult {
  total_active: number;
  topics: Array<{ topic: string; count: number }>;
  recalled_last_24h: number;
  strength_distribution: { low: number; medium: number; high: number };
}

export interface MessageMetadata {
  classification?: string;
  executor?: string;
  procHit?: boolean;
  latencyMs?: number;
  cost?: number;
  confidence?: number;
  reclassified?: boolean;
  probeResult?: string;
  error?: boolean;
}
