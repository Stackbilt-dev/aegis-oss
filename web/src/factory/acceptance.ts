// Deterministic acceptance checks for do_sandbox tasks (AGENTS.md G15).
//
// A task prompt may carry one fenced block:
//
//   ```acceptance
//   { "changed_files_only": ["web/tests/sanitize.test.ts"],
//     "max_added_lines": 1, "max_deleted_lines": 1,
//     "file_excludes": [{ "path": "web/tests/sanitize.test.ts", "text": "aegis_0536" }],
//     "tests": [{ "command": "pnpm exec vitest run tests/sanitize.test.ts", "passed": 20 }] }
//   ```
//
// The executor evaluates it after the tool loop and before publication. The
// verdict comes only from facts the checker gathers itself: the staged tree,
// file contents, and test commands it re-runs. The model's summary and its
// recorded tool output are never consulted — trusting them is the G15 defect
// (task d3319cb8 / PR #749 claimed two new tests and the suite count never moved).

import { isAllowedVerificationCommand, normalizeRepositoryPath } from './harness.js';

export interface AcceptanceSpec {
  changed_files_only?: string[];
  changed_files_required?: string[];
  max_added_lines?: number;
  max_deleted_lines?: number;
  file_contains?: Array<{ path: string; text: string }>;
  file_excludes?: Array<{ path: string; text: string }>;
  tests?: Array<{ command: string; passed: number }>;
}

export type ParsedAcceptance =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'spec'; spec: AcceptanceSpec };

export interface ChangedFile {
  path: string;
  added: number;
  deleted: number;
}

export interface AcceptanceFacts {
  listChangedFiles(): Promise<ChangedFile[]>;
  /** Current file content, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Re-run a vitest command with a JSON report; `report` is the report text, or null if none was written. */
  runTests(command: string): Promise<{ exitCode: number; report: string | null }>;
}

export interface AcceptanceCheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceVerdict {
  status: 'passed' | 'failed' | 'unchecked';
  checks: AcceptanceCheckResult[];
  changedFiles: ChangedFile[];
}

const BLOCK_PATTERN = /```acceptance[ \t]*\r?\n([\s\S]*?)```/g;
const SPEC_KEYS = new Set<keyof AcceptanceSpec>([
  'changed_files_only',
  'changed_files_required',
  'max_added_lines',
  'max_deleted_lines',
  'file_contains',
  'file_excludes',
  'tests',
]);

export function parseAcceptanceSpec(prompt: string): ParsedAcceptance {
  const blocks = [...prompt.matchAll(BLOCK_PATTERN)];
  if (blocks.length === 0) {
    return /```acceptance/.test(prompt)
      ? { kind: 'invalid', error: 'acceptance block is not closed' }
      : { kind: 'absent' };
  }
  if (blocks.length > 1) return { kind: 'invalid', error: 'more than one acceptance block' };

  let raw: unknown;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (error) {
    return { kind: 'invalid', error: `acceptance block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { kind: 'spec', spec: validateSpec(raw) };
  } catch (error) {
    return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Admission rule shared by task creation and the executor: a malformed block is
 * always rejected, and unattended (`auto_safe`) tasks must declare one. Returns
 * the rejection reason, or null when the task may run.
 */
export function acceptanceAdmissionError(parsed: ParsedAcceptance, authority: string): string | null {
  if (parsed.kind === 'invalid') return `acceptance block rejected: ${parsed.error}`;
  if (parsed.kind === 'absent' && authority === 'auto_safe') {
    return 'auto_safe do_sandbox tasks must declare an ```acceptance block; use operator authority to run without one';
  }
  return null;
}

function validateSpec(raw: unknown): AcceptanceSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('acceptance block must be a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !SPEC_KEYS.has(key as keyof AcceptanceSpec));
  if (unknownKeys.length > 0) throw new Error(`unsupported acceptance keys: ${unknownKeys.join(', ')}`);
  if (Object.keys(input).length === 0) throw new Error('acceptance block declares no checks');

  const spec: AcceptanceSpec = {};
  for (const key of ['changed_files_only', 'changed_files_required'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array of paths`);
    spec[key] = value.map((path) => normalizeRepositoryPath(path));
  }
  for (const key of ['max_added_lines', 'max_deleted_lines'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
    spec[key] = value;
  }
  for (const key of ['file_contains', 'file_excludes'] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} must be a non-empty array`);
    spec[key] = value.map((entry) => {
      const item = entry as Record<string, unknown> | null;
      if (!item || typeof item.text !== 'string' || !item.text) {
        throw new Error(`${key} entries need a path and non-empty text`);
      }
      return { path: normalizeRepositoryPath(item.path), text: item.text };
    });
  }
  if (input.tests !== undefined) {
    if (!Array.isArray(input.tests) || input.tests.length === 0) throw new Error('tests must be a non-empty array');
    spec.tests = input.tests.map((entry) => {
      const item = entry as Record<string, unknown> | null;
      if (!item || !isAllowedVerificationCommand(item.command) || !VITEST_RUN.test(item.command.trim())) {
        throw new Error('tests entries need a `pnpm exec vitest run`, `npx vitest run`, or `yarn vitest run` command');
      }
      if (/['"\\(){}]/.test(item.command)) {
        throw new Error('tests commands must not contain quotes, backslashes, or brackets');
      }
      if (/--(?:reporter|outputFile)\b/.test(item.command)) {
        throw new Error('tests commands must not set a reporter or output file; the checker sets them');
      }
      if (typeof item.passed !== 'number' || !Number.isInteger(item.passed) || item.passed < 1) {
        throw new Error('tests entries need passed as a positive integer');
      }
      return { command: item.command.trim(), passed: item.passed };
    });
  }
  return spec;
}

// The same runners @stackbilt/agent-acceptance accepts, so one contract can be
// checked by both the executor and the Action.
const VITEST_RUN = /^(?:pnpm\s+exec|npx|yarn)\s+vitest\s+run(?:\s|$)/;

/**
 * Counts come from vitest's JSON report at a path chosen at check time, never
 * from its text summary: the test file under check is usually the one the model
 * edited, and it can print its own `Tests  N passed` line after vitest's.
 */
export function vitestJsonCommand(command: string, outputPath: string): string {
  return `${command} --reporter=json --outputFile=${outputPath}`;
}

export function parseVitestJsonReport(
  report: string | null,
): { passed: number; failed: number; success: boolean } | null {
  if (!report) return null;
  try {
    const data = JSON.parse(report) as Record<string, unknown>;
    if (typeof data.numPassedTests !== 'number' || typeof data.numFailedTests !== 'number') return null;
    return { passed: data.numPassedTests, failed: data.numFailedTests, success: data.success === true };
  } catch {
    return null;
  }
}

/**
 * Stages the tree and prints its numstat base64-encoded. The sandbox's RPC
 * transport strips NUL bytes from stdout, which merged every `-z` record into
 * one: a two-file change parsed as a single path with the first file's line
 * counts (canary task 582da644). Base64 carries the bytes intact.
 */
export const STAGED_NUMSTAT_COMMAND = 'git add -A && git diff --cached --numstat --no-renames -z | base64 -w0';

/** Decode STAGED_NUMSTAT_COMMAND output. Throws when the NUL framing did not survive. */
export function decodeStagedNumstat(encoded: string): ChangedFile[] {
  const bytes = Uint8Array.from(atob(encoded.replace(/\s+/g, '')), (char) => char.charCodeAt(0));
  const output = new TextDecoder().decode(bytes);
  if (output && !output.endsWith('\0')) {
    throw new Error('numstat output lost its NUL framing; refusing to evaluate changed files');
  }
  return parseNumstat(output);
}

/** Parse `git diff --cached --numstat --no-renames -z`. Binary files count as zero lines. */
export function parseNumstat(output: string): ChangedFile[] {
  return output
    .split('\0')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...path] = record.split('\t');
      return {
        path: path.join('\t'),
        added: added === '-' ? 0 : Number(added),
        deleted: deleted === '-' ? 0 : Number(deleted),
      };
    });
}

export async function evaluateAcceptance(
  spec: AcceptanceSpec | null,
  facts: AcceptanceFacts,
): Promise<AcceptanceVerdict> {
  const changedFiles = await facts.listChangedFiles();
  if (!spec) return { status: 'unchecked', checks: [], changedFiles };

  const checks: AcceptanceCheckResult[] = [];
  const changed = new Set(changedFiles.map((file) => file.path));

  if (spec.changed_files_only) {
    const allowed = new Set(spec.changed_files_only);
    const extra = [...changed].filter((path) => !allowed.has(path));
    checks.push({
      check: 'changed_files_only',
      ok: extra.length === 0,
      detail: extra.length === 0 ? `changed: ${[...changed].join(', ') || '(none)'}` : `unexpected changes: ${extra.join(', ')}`,
    });
  }
  if (spec.changed_files_required) {
    const missing = spec.changed_files_required.filter((path) => !changed.has(path));
    checks.push({
      check: 'changed_files_required',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all required files changed' : `not changed: ${missing.join(', ')}`,
    });
  }
  const added = changedFiles.reduce((sum, file) => sum + file.added, 0);
  const deleted = changedFiles.reduce((sum, file) => sum + file.deleted, 0);
  if (spec.max_added_lines !== undefined) {
    checks.push({
      check: 'max_added_lines',
      ok: added <= spec.max_added_lines,
      detail: `${added} added (limit ${spec.max_added_lines})`,
    });
  }
  if (spec.max_deleted_lines !== undefined) {
    checks.push({
      check: 'max_deleted_lines',
      ok: deleted <= spec.max_deleted_lines,
      detail: `${deleted} deleted (limit ${spec.max_deleted_lines})`,
    });
  }
  for (const { path, text } of spec.file_contains ?? []) {
    const content = await facts.readFile(path);
    checks.push({
      check: 'file_contains',
      ok: content !== null && content.includes(text),
      detail: content === null ? `${path} does not exist` : `${path} ${content.includes(text) ? 'contains' : 'lacks'} ${JSON.stringify(text)}`,
    });
  }
  for (const { path, text } of spec.file_excludes ?? []) {
    const content = await facts.readFile(path);
    const present = content !== null && content.includes(text);
    checks.push({
      check: 'file_excludes',
      ok: !present,
      detail: `${path} ${present ? 'still contains' : 'does not contain'} ${JSON.stringify(text)}`,
    });
  }
  for (const { command, passed } of spec.tests ?? []) {
    const run = await facts.runTests(command);
    const report = parseVitestJsonReport(run.report);
    const ok = run.exitCode === 0 && report !== null && report.success
      && report.failed === 0 && report.passed === passed;
    checks.push({
      check: 'tests',
      ok,
      detail: report
        ? `${command}: exit ${run.exitCode}, ${report.passed} passed, ${report.failed} failed (expected ${passed} passed)`
        : `${command}: exit ${run.exitCode}, no JSON test report written`,
    });
  }

  return { status: checks.every((check) => check.ok) ? 'passed' : 'failed', checks, changedFiles };
}

export function formatAcceptanceReport(verdict: AcceptanceVerdict): string {
  if (verdict.status === 'unchecked') {
    return 'Acceptance: **not machine-checked** — the task declared no `acceptance` block. Verify the diff against the task by hand.';
  }
  const passed = verdict.checks.filter((check) => check.ok).length;
  const lines = verdict.checks.map((check) => `- ${check.ok ? '✅' : '❌'} \`${check.check}\` — ${check.detail}`);
  return [`Acceptance: ${passed}/${verdict.checks.length} checks passed (re-run by the executor, not reported by the model).`, '', ...lines].join('\n');
}

export function acceptanceResultNote(verdict: AcceptanceVerdict): string {
  return verdict.status === 'unchecked'
    ? 'acceptance: not machine-checked'
    : `acceptance: ${verdict.checks.filter((check) => check.ok).length}/${verdict.checks.length} checks passed`;
}
