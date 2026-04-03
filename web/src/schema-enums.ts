// ─── Centralized Schema Enums ────────────────────────────────
//
// Single source of truth for all D1 CHECK constraint values.
// SQL schema.sql defines the CHECK constraints; this file mirrors
// them for TypeScript. When adding a new enum value, update BOTH
// this file and the corresponding CHECK in schema.sql.
//
// Rule: no enum literal should appear inline in routes or kernel
// files. Import from here.

// ─── Helpers ─────────────────────────────────────────────────

/** Derive a union type from a const array. */
type EnumValues<T extends readonly string[]> = T[number];

// ─── Chat ────────────────────────────────────────────────────

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = EnumValues<typeof MESSAGE_ROLES>;

// ─── Memory ──────────────────────────────────────────────────

export const VALIDATION_STAGES = ['candidate', 'validated', 'expert', 'canonical', 'refuted'] as const;
export type ValidationStage = EnumValues<typeof VALIDATION_STAGES>;

export const EPISODIC_OUTCOMES = ['success', 'failure'] as const;
export type EpisodicOutcome = EnumValues<typeof EPISODIC_OUTCOMES>;

export const PROCEDURAL_STATUSES = ['learning', 'learned', 'degraded', 'broken'] as const;
export type ProceduralStatus = EnumValues<typeof PROCEDURAL_STATUSES>;

// ─── Agenda ──────────────────────────────────────────────────

export const AGENDA_PRIORITIES = ['low', 'medium', 'high'] as const;
export type AgendaPriority = EnumValues<typeof AGENDA_PRIORITIES>;

export const AGENDA_STATUSES = ['active', 'done', 'dismissed'] as const;
export type AgendaStatus = EnumValues<typeof AGENDA_STATUSES>;

// ─── Goals & Actions ─────────────────────────────────────────

export const GOAL_STATUSES = ['active', 'paused', 'completed', 'failed'] as const;
export type GoalStatus = EnumValues<typeof GOAL_STATUSES>;

export const AUTHORITY_LEVELS = ['propose', 'auto_low', 'auto_high'] as const;
export type AuthorityLevel = EnumValues<typeof AUTHORITY_LEVELS>;

export const ACTION_TYPES = ['proposed', 'executed', 'skipped'] as const;
export type ActionType = EnumValues<typeof ACTION_TYPES>;

export const ACTION_OUTCOMES = ['success', 'failure', 'pending'] as const;
export type ActionOutcome = EnumValues<typeof ACTION_OUTCOMES>;

// ─── Task Observability ─────────────────────────────────────

export const HEARTBEAT_STATUSES = ['ok', 'error', 'skipped'] as const;
export type HeartbeatStatus = EnumValues<typeof HEARTBEAT_STATUSES>;

// ─── CC Tasks ────────────────────────────────────────────────

export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = EnumValues<typeof TASK_STATUSES>;

export const TASK_AUTHORITIES = ['proposed', 'auto_safe', 'operator'] as const;
export type TaskAuthority = EnumValues<typeof TASK_AUTHORITIES>;

export const TASK_CATEGORIES = ['docs', 'tests', 'research', 'bugfix', 'feature', 'refactor', 'deploy'] as const;
export type TaskCategory = EnumValues<typeof TASK_CATEGORIES>;

/** Categories that execute without operator approval. */
export const AUTO_SAFE_CATEGORIES = new Set<TaskCategory>(['docs', 'tests', 'research', 'refactor']);

/** Categories that require approval before execution. */
export const PROPOSED_CATEGORIES = new Set<TaskCategory>(['bugfix', 'feature']);

/** Subset safe for PR automerge. */
export const AUTOMERGE_SAFE_CATEGORIES = new Set<TaskCategory>(['docs', 'tests', 'research']);

// ─── Narratives ─────────────────────────────────────────────

export const MEMORY_GOAL_STATUSES = ['active', 'resolved', 'stalled', 'abandoned'] as const;
export type MemoryGoalStatus = EnumValues<typeof MEMORY_GOAL_STATUSES>;

// ─── Knowledge Graph ─────────────────────────────────────────

export const NODE_TYPES = [
  'concept', 'project', 'person', 'decision', 'pattern', 'tool', 'event',
  'file', 'module', 'function', 'class', 'interface', 'type_alias',
] as const;
export type NodeType = EnumValues<typeof NODE_TYPES>;

export const SOURCE_SYSTEMS = ['cognitive', 'code', 'manual'] as const;
export type SourceSystem = EnumValues<typeof SOURCE_SYSTEMS>;

export const EDGE_RELATIONS = ['depends_on', 'part_of', 'decided_by', 'blocks', 'uses', 'related_to', 'caused'] as const;
export type EdgeRelation = EnumValues<typeof EDGE_RELATIONS>;

// ─── Feedback ────────────────────────────────────────────────

export const FEEDBACK_CATEGORIES = ['general', 'bug', 'feature', 'question'] as const;
export type FeedbackCategory = EnumValues<typeof FEEDBACK_CATEGORIES>;

export const FEEDBACK_SOURCES = ['web', 'mcp', 'api'] as const;
export type FeedbackSource = EnumValues<typeof FEEDBACK_SOURCES>;

// ─── Board ───────────────────────────────────────────────────

export const BOARD_COLUMNS = ['backlog', 'queued', 'in_progress', 'blocked', 'shipped'] as const;
export type BoardColumn = EnumValues<typeof BOARD_COLUMNS>;

export const CONTENT_TYPES = ['issue', 'pr'] as const;
export type ContentType = EnumValues<typeof CONTENT_TYPES>;

// ─── Content Queue ───────────────────────────────────────────

export const CONTENT_QUEUE_STATUSES = ['scheduled', 'published', 'failed', 'cancelled'] as const;
export type ContentQueueStatus = EnumValues<typeof CONTENT_QUEUE_STATUSES>;

// ─── Dynamic Tools ───────────────────────────────────────────

export const TOOL_EXECUTORS = ['gpt_oss', 'workers_ai', 'groq'] as const;
export type ToolExecutor = EnumValues<typeof TOOL_EXECUTORS>;

export const TOOL_STATUSES = ['active', 'promoted', 'retired', 'draft'] as const;
export type ToolStatus = EnumValues<typeof TOOL_STATUSES>;

// ─── CodeBeast Findings ─────────────────────────────────────

export const FINDING_SEVERITIES = ['HIGH', 'MID', 'LOW', 'INFO'] as const;
export type FindingSeverity = EnumValues<typeof FINDING_SEVERITIES>;

export const FINDING_CATEGORIES = ['SECURITY', 'LOGIC', 'STYLE', 'DEPENDENCY', 'BOUNDARY'] as const;
export type FindingCategory = EnumValues<typeof FINDING_CATEGORIES>;

export const FINDING_PRIORITIES = ['high', 'medium', 'low'] as const;
export type FindingPriority = EnumValues<typeof FINDING_PRIORITIES>;

export const FINDING_STATUSES = ['open', 'resolved'] as const;
export type FindingStatus = EnumValues<typeof FINDING_STATUSES>;

// ─── Validation Helpers ──────────────────────────────────────

/** Check if a value is a valid member of a const enum array. */
export function isValidEnum<T extends readonly string[]>(values: T, input: unknown): input is T[number] {
  return typeof input === 'string' && (values as readonly string[]).includes(input);
}

/** Validate and return the value, or fall back to a default. */
export function validateEnum<T extends readonly string[]>(
  values: T,
  input: unknown,
  fallback: T[number],
): T[number] {
  return isValidEnum(values, input) ? input : fallback;
}
