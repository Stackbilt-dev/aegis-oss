// Task intelligence stubs for OSS build
// Full implementation is proprietary

export interface TaskFailureInput {
  title: string | null;
  repo: string | null;
  category: string | null;
  error: string | null;
  result: string | null;
  exitCode: number | null;
  preflight: TaskPreflight | null;
}

export interface TaskAutopsy {
  kind: string;
  retryable: boolean;
  summary: string;
}

export interface TaskPreflight {
  warnings?: string[];
  test_command?: string | null;
  base_branch?: string | null;
}

export function classifyTaskFailure(input: TaskFailureInput): TaskAutopsy {
  return {
    kind: 'unknown',
    retryable: false,
    summary: input.error ?? 'Unknown failure',
  };
}

export function parseTaskPreflight(raw: unknown): TaskPreflight | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as TaskPreflight; } catch { return null; }
  }
  return raw as TaskPreflight;
}

export function collectContractAlerts(
  _failures: Array<{
    id?: string;
    repo?: string;
    completed_at?: string | null;
    autopsy_json?: string | null;
  }>,
): unknown[] {
  return [];
}
