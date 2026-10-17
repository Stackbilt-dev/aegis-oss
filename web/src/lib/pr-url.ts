// cc_tasks.pr_url doubles as tracking state: the pr-ready heartbeat appends
// '/closed' (0.10.0+), and pr-automerge appended '/merged' (before 0.10.0),
// once they stop tracking a PR. Those URLs 404 on GitHub, so pages and
// messages that show or link a stored pr_url strip the suffix. The task API
// (GET /api/cc-tasks) returns the stored value unchanged.

const TRACKING_SUFFIX = /\/(closed|merged)$/;

export function prLink(prUrl: string): string;
export function prLink(prUrl: string | null): string | null;
export function prLink(prUrl: string | null): string | null {
  return prUrl === null ? null : prUrl.replace(TRACKING_SUFFIX, '');
}
