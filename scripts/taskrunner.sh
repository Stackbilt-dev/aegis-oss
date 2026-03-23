#!/usr/bin/env bash
# taskrunner.sh — AEGIS-orchestrated Claude Code task runner
#
# Polls AEGIS for pending cc_tasks, executes them via `claude -p`,
# posts results back. Designed for unattended overnight operation.
#
# v2: worktree isolation, signal traps, per-repo locking.
# Developer's checkout is NEVER mutated by task execution.
#
# Usage:
#   ./scripts/taskrunner.sh              # Run until queue empty
#   ./scripts/taskrunner.sh --max 10     # Run at most 10 tasks
#   ./scripts/taskrunner.sh --loop       # Loop forever (poll every 60s)
#   ./scripts/taskrunner.sh --dry-run    # Show what would run without executing

set -euo pipefail

# Force line-buffered stdout so output isn't truncated when run in background
if [[ -z "${CC_UNBUFFERED:-}" ]] && command -v stdbuf >/dev/null 2>&1; then
  export CC_UNBUFFERED=1
  exec stdbuf -oL "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AEGIS_URL="${AEGIS_URL:-https://your-aegis-instance.example.com}"
AEGIS_TOKEN="${AEGIS_TOKEN:-YOUR_AEGIS_TOKEN}"
REPOS_ROOT="${REPOS_ROOT:-/path/to/your/repos}"
HOOKS_SETTINGS="${SCRIPT_DIR}/hooks/autonomous-settings.json"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
MAX_TASKS="${MAX_TASKS:-0}"  # 0 = unlimited
LOCK_DIR="${LOCK_DIR:-/tmp/cc-taskrunner-locks}"
DRY_RUN=false
LOOP_MODE=false
TASKS_RUN=0
TASK_PREFLIGHT_JSON=""
TASK_META_TITLE=""
TASK_META_REPO=""
TASK_META_CATEGORY=""

# Cleanup state for signal traps
_CLEANUP_WORKTREE=""
_CLEANUP_BRANCH=""
_CLEANUP_REPO=""
_CLEANUP_REPO_LOCKFD=""
_CLEANUP_TMPFILES=()

# ─── Parse args ──────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max)    MAX_TASKS="$2"; shift 2 ;;
    --loop)   LOOP_MODE=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *)        echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

# ─── Cleanup trap ────────────────────────────────────────────

cleanup() {
  local exit_code=$?

  # Remove worktree if it exists
  if [[ -n "$_CLEANUP_WORKTREE" && -d "$_CLEANUP_WORKTREE" ]]; then
    log "│  Cleaning up worktree: ${_CLEANUP_WORKTREE}"
    cd "$_CLEANUP_REPO" 2>/dev/null || cd /
    git worktree remove --force "$_CLEANUP_WORKTREE" 2>/dev/null || rm -rf "$_CLEANUP_WORKTREE"
  fi

  # Delete the task branch if it has no remote and no commits beyond base
  if [[ -n "$_CLEANUP_BRANCH" && -n "$_CLEANUP_REPO" ]]; then
    cd "$_CLEANUP_REPO" 2>/dev/null || true
    if ! git show-ref --verify --quiet "refs/remotes/origin/${_CLEANUP_BRANCH}" 2>/dev/null; then
      git branch -D "$_CLEANUP_BRANCH" 2>/dev/null || true
    fi
  fi

  # Remove temp files
  for f in "${_CLEANUP_TMPFILES[@]}"; do
    rm -f "$f" 2>/dev/null || true
  done

  # Release repo lock
  if [[ -n "$_CLEANUP_REPO_LOCKFD" ]]; then
    eval "exec ${_CLEANUP_REPO_LOCKFD}>&-" 2>/dev/null || true
  fi

  _CLEANUP_WORKTREE=""
  _CLEANUP_BRANCH=""
  _CLEANUP_REPO=""
  _CLEANUP_REPO_LOCKFD=""
  _CLEANUP_TMPFILES=()

  return $exit_code
}

trap cleanup EXIT INT TERM

# ─── Locking ─────────────────────────────────────────────────

acquire_lock() {
  local lockfile="$1" fd="$2" timeout="${3:-5}"
  mkdir -p "$LOCK_DIR"
  eval "exec ${fd}>\"${lockfile}\""
  if ! flock -w "$timeout" "$fd"; then
    err "Could not acquire lock: ${lockfile}"
    return 1
  fi
}

release_lock() {
  local fd="$1"
  eval "exec ${fd}>&-" 2>/dev/null || true
}

# ─── AEGIS API ───────────────────────────────────────────────

aegis_api() {
  local method="$1" path="$2"
  shift 2
  curl -s -m 30 -X "$method" "${AEGIS_URL}${path}" \
    -H "Authorization: Bearer ${AEGIS_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@"
}

fetch_next_task() {
  aegis_api GET "/api/cc-tasks/next"
}

mark_started() {
  local task_id="$1" session_id="$2"
  SESSION_ID="$session_id" PREFLIGHT="${TASK_PREFLIGHT_JSON:-}" python3 -c '
import json, os
payload = {"session_id": os.environ["SESSION_ID"]}
preflight = os.environ.get("PREFLIGHT", "")
if preflight:
    payload["preflight"] = json.loads(preflight)
print(json.dumps(payload))
' | aegis_api POST "/api/cc-tasks/${task_id}/start" -d @-
}

mark_completed() {
  local task_id="$1" exit_code="$2"
  local result_file="$3"
  local pr_url="${4:-}"
  local branch="${5:-}"

  local result
  result=$(head -c 4000 "$result_file" 2>/dev/null || echo "")

  RESULT="$result" EXIT_CODE="$exit_code" PR_URL="$pr_url" BRANCH="$branch" PREFLIGHT="${TASK_PREFLIGHT_JSON:-}" TASK_TITLE="${TASK_META_TITLE:-}" TASK_REPO="${TASK_META_REPO:-}" TASK_CATEGORY="${TASK_META_CATEGORY:-}" python3 -c '
import json, os, sys
result = os.environ["RESULT"]
exit_code = int(os.environ["EXIT_CODE"])
pr_url = os.environ.get("PR_URL", "")
branch = os.environ.get("BRANCH", "")
status = "completed" if exit_code == 0 else "failed"
payload = {
    "status": status,
    "exit_code": exit_code,
    "result": result,
    "task_title": os.environ.get("TASK_TITLE", ""),
    "repo": os.environ.get("TASK_REPO", ""),
    "category": os.environ.get("TASK_CATEGORY", ""),
}
if pr_url:
    payload["pr_url"] = pr_url
if branch:
    payload["branch"] = branch

# Classify failure kind for autopsy
if exit_code != 0:
    payload["error"] = f"Exit code {exit_code}"
    rl = result.lower()
    if "repo not found" in rl:
        kind, retryable = "repo_not_found", False
    elif "repo locked" in rl:
        kind, retryable = "repo_locked", True
    elif "auth" in rl and ("401" in rl or "preflight" in rl or "authentication" in rl):
        kind, retryable = "auth_failure", True
    elif "max_turns" in rl or "error_max_turns" in rl:
        kind, retryable = "max_turns_exceeded", True
    elif "uncommitted" in rl:
        kind, retryable = "uncommitted_changes", True
    elif "no such file" in rl and "claude" in rl:
        kind, retryable = "claude_binary_missing", False
    elif "base branch" in rl:
        kind, retryable = "git_branch_error", True
    else:
        kind, retryable = "unknown", True
    payload["autopsy"] = {"kind": kind, "retryable": retryable, "exit_code": exit_code, "result_snippet": result[:200]}

preflight = os.environ.get("PREFLIGHT", "")
if preflight:
    payload["preflight"] = json.loads(preflight)
print(json.dumps(payload))
' | aegis_api POST "/api/cc-tasks/${task_id}/complete" -d @-
}

# ─── Resolve repo path ──────────────────────────────────────

resolve_repo() {
  local repo="$1"

  # Map short names to actual repo directory names.
  # Customize this for your org's repos.
  declare -A REPO_ALIASES=(
    # [short-name]=directory-name
    # Example:
    # [my-api]=my-api-repo
    # [frontend]=frontend-v2
  )

  local resolved="${REPO_ALIASES[$repo]:-$repo}"
  local path="${REPOS_ROOT}/${resolved}"
  if [[ -d "$path" ]]; then
    echo "$path"
  else
    err "Repo not found: ${repo} (resolved to ${resolved}, tried ${path})"
    return 1
  fi
}

# ─── Resolve base branch ────────────────────────────────────

resolve_base_branch() {
  local repo_path="$1"
  cd "$repo_path"

  # Try remote HEAD (most reliable for the repo's default branch)
  local remote_head
  remote_head=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||') || true

  if [[ -n "$remote_head" ]]; then
    echo "$remote_head"
    return
  fi

  # Fall back to checking for common branch names
  for candidate in main master; do
    if git rev-parse --verify "refs/heads/${candidate}" >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done

  err "Could not determine base branch for ${repo_path}"
  return 1
}

detect_package_manager() {
  local dir="$1"
  if [[ -f "$dir/pnpm-lock.yaml" || -f "$dir/pnpm-workspace.yaml" ]]; then
    echo "pnpm"
    return
  fi
  echo "npm"
}

detect_test_command() {
  local repo_path="$1"
  local rel dir manager
  for rel in "." "web" "e2e"; do
    if [[ "$rel" == "." ]]; then
      dir="$repo_path"
    else
      dir="$repo_path/$rel"
    fi
    [[ -f "$dir/package.json" ]] || continue
    if python3 -c '
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
scripts = data.get("scripts", {})
print("yes" if scripts.get("test") else "no")
' "$dir/package.json" 2>/dev/null | grep -q '^yes$'; then
      manager=$(detect_package_manager "$dir")
      if [[ "$rel" == "." ]]; then
        echo "${manager} test"
      elif [[ "$manager" == "pnpm" ]]; then
        echo "pnpm --dir ${rel} test"
      else
        echo "npm --prefix ${rel} test"
      fi
      return 0
    fi
  done
  return 1
}

build_preflight_json() {
  local repo="$1" repo_path="$2" category="$3" authority="$4" base_branch="${5:-}"
  local repo_exists=true
  local git_repo=false
  local test_command=""
  local warnings=()

  if [[ ! -d "$repo_path" ]]; then
    repo_exists=false
    warnings+=("Resolved repo path does not exist on this runner")
  fi

  if [[ -d "$repo_path" ]] && git -C "$repo_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_repo=true
  elif [[ -d "$repo_path" ]]; then
    warnings+=("Resolved repo path is not a git worktree")
  fi

  test_command=$(detect_test_command "$repo_path" 2>/dev/null || echo "")
  if [[ "$category" == "tests" && -z "$test_command" ]]; then
    warnings+=("No obvious test command detected in root/web/e2e package.json")
  fi

  PREFLIGHT_WARNINGS=$(printf '%s\x1f' "${warnings[@]}") \
  PREFLIGHT_REPO="$repo" \
  PREFLIGHT_REPO_EXISTS="$repo_exists" \
  PREFLIGHT_REPO_PATH="$repo_path" \
  PREFLIGHT_GIT_REPO="$git_repo" \
  PREFLIGHT_AUTHORITY="$authority" \
  PREFLIGHT_CATEGORY="$category" \
  PREFLIGHT_BASE_BRANCH="$base_branch" \
  PREFLIGHT_TEST_COMMAND="$test_command" \
  python3 -c '
import json, os
warnings = [w for w in os.environ.get("PREFLIGHT_WARNINGS", "").split("\x1f") if w]
print(json.dumps({
    "repo": os.environ.get("PREFLIGHT_REPO", ""),
    "repo_exists": os.environ.get("PREFLIGHT_REPO_EXISTS", "false") == "true",
    "repo_path": os.environ.get("PREFLIGHT_REPO_PATH") or None,
    "git_repo": os.environ.get("PREFLIGHT_GIT_REPO", "false") == "true",
    "authority": os.environ.get("PREFLIGHT_AUTHORITY", ""),
    "category": os.environ.get("PREFLIGHT_CATEGORY", ""),
    "base_branch": os.environ.get("PREFLIGHT_BASE_BRANCH") or None,
    "test_command": os.environ.get("PREFLIGHT_TEST_COMMAND") or None,
    "warnings": warnings,
}))
'
}

build_missing_repo_preflight() {
  local repo="$1" category="$2" authority="$3"
  PREFLIGHT_REPO="$repo" PREFLIGHT_AUTHORITY="$authority" PREFLIGHT_CATEGORY="$category" python3 -c '
import json, os
print(json.dumps({
    "repo": os.environ.get("PREFLIGHT_REPO", ""),
    "repo_exists": False,
    "repo_path": None,
    "git_repo": False,
    "authority": os.environ.get("PREFLIGHT_AUTHORITY", ""),
    "category": os.environ.get("PREFLIGHT_CATEGORY", ""),
    "base_branch": None,
    "test_command": None,
    "warnings": ["Resolved repo path does not exist on this runner"],
}))
'
}

render_preflight_prompt() {
  PREFLIGHT="${TASK_PREFLIGHT_JSON:-}" python3 -c '
import json, os
raw = os.environ.get("PREFLIGHT", "")
if not raw:
    print("")
    raise SystemExit(0)
data = json.loads(raw)
lines = ["## Task Preflight"]
if data.get("repo_path"):
    lines.append("- Repo path: " + str(data["repo_path"]))
if data.get("base_branch"):
    lines.append("- Base branch: " + str(data["base_branch"]))
if data.get("test_command"):
    lines.append("- Detected test command: " + str(data["test_command"]))
warnings = data.get("warnings") or []
if warnings:
    lines.append("- Warnings:")
    for warning in warnings:
        lines.append(f"  - {warning}")
else:
    lines.append("- Warnings: none")
print("\n".join(lines))
'
}

finish_task_attempt() {
  TASKS_RUN=$((TASKS_RUN + 1))
  TASK_PREFLIGHT_JSON=""
  TASK_META_TITLE=""
  TASK_META_REPO=""
  TASK_META_CATEGORY=""
}

# ─── Build Claude command ────────────────────────────────────

build_claude_cmd() {
  local prompt="$1" max_turns="$2" allowed_tools="$3"

  local cmd=(
    claude
    -p "$prompt"
    --dangerously-skip-permissions
    --output-format json
    --max-turns "$max_turns"
    --settings "$HOOKS_SETTINGS"
  )

  if [[ -n "$allowed_tools" && "$allowed_tools" != "null" ]]; then
    while IFS= read -r tool; do
      cmd+=(--allowedTools "$tool")
    done < <(echo "$allowed_tools" | python3 -c 'import json,sys; [print(t) for t in json.load(sys.stdin)]' 2>/dev/null)
  fi

  printf '%q ' "${cmd[@]}"
}

# ─── Large-file guardrail ─────────────────────────────────

adjust_max_turns_for_loc() {
  local prompt="$1" repo_path="$2" current_max="$3"
  local new_max="$current_max"

  local files
  files=$(echo "$prompt" | grep -oE '[a-zA-Z0-9_./-]+\.(ts|tsx|js|jsx|py|rs|go|sh|sql)' | sort -u)

  if [[ -z "$files" ]]; then
    echo "$new_max"
    return
  fi

  local max_loc=0
  local largest_file=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    local full_path="${repo_path}/${f}"
    if [[ -f "$full_path" ]]; then
      local loc
      loc=$(wc -l < "$full_path" 2>/dev/null || echo "0")
      loc=$(echo "$loc" | tr -d ' ')
      if [[ "$loc" -gt "$max_loc" ]]; then
        max_loc="$loc"
        largest_file="$f"
      fi
    fi
  done <<< "$files"

  if [[ "$max_loc" -gt 1500 ]]; then
    new_max=50
    log "│  Large file detected: ${largest_file} (${max_loc} LOC) → max_turns bumped to ${new_max}" >&2
  elif [[ "$max_loc" -gt 800 ]]; then
    new_max=40
    log "│  Large file detected: ${largest_file} (${max_loc} LOC) → max_turns bumped to ${new_max}" >&2
  fi

  if [[ "$new_max" -lt "$current_max" ]]; then
    new_max="$current_max"
  fi

  # Repo-complexity baseline: large multi-file repos need more turns even without explicit file paths
  local ts_count
  ts_count=$(find "$repo_path/src" -name "*.ts" -o -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$ts_count" -gt 80 && "$new_max" -lt 40 ]]; then
    new_max=40
    log "│  Complex repo detected (${ts_count} TS files) → max_turns baseline ${new_max}" >&2
  fi

  echo "$new_max"
}

# ─── Execute single task ────────────────────────────────────

execute_task() {
  local task_json="$1"
  TASK_PREFLIGHT_JSON=""

  local task_id title repo prompt completion_signal max_turns allowed_tools authority category
  task_id=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  title=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])')
  repo=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["repo"])')
  prompt=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["prompt"])')
  completion_signal=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("completion_signal") or "")' 2>/dev/null)
  max_turns=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("max_turns", 25))' 2>/dev/null)
  allowed_tools=$(echo "$task_json" | python3 -c 'import json,sys; t=json.load(sys.stdin).get("allowed_tools"); print(json.dumps(t) if t else "")' 2>/dev/null)
  authority=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("authority", "operator"))' 2>/dev/null)
  category=$(echo "$task_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("category", "feature"))' 2>/dev/null)
  gh_issue_repo=$(echo "$task_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("github_issue_repo") or "")' 2>/dev/null || echo "")
  gh_issue_number=$(echo "$task_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("github_issue_number") or "")' 2>/dev/null || echo "")
  TASK_META_TITLE="$title"
  TASK_META_REPO="$repo"
  TASK_META_CATEGORY="$category"

  log "┌─ Task: ${title}"
  log "│  ID:   ${task_id}"
  log "│  Repo: ${repo}"
  log "│  Turns: ${max_turns}"
  log "│  Authority: ${authority}"

  if $DRY_RUN; then
    log "└─ [DRY RUN] Would execute. Skipping."
    finish_task_attempt
    return 0
  fi

  # Resolve repo path
  local repo_path
  if ! repo_path=$(resolve_repo "$repo"); then
    TASK_PREFLIGHT_JSON=$(build_missing_repo_preflight "$repo" "$category" "$authority")
    mark_completed "$task_id" 1 <(echo "Repo not found: ${repo}")
    finish_task_attempt
    return 1
  fi

  # Large-file guardrail
  max_turns=$(adjust_max_turns_for_loc "$prompt" "$repo_path" "$max_turns")
  TASK_PREFLIGHT_JSON=$(build_preflight_json "$repo" "$repo_path" "$category" "$authority")

  # Auth preflight: verify claude CLI exists and can authenticate.
  # Catches missing binary and expired keys before burning a full task attempt.
  if ! command -v claude >/dev/null 2>&1; then
    err "Claude binary not found in PATH"
    mark_completed "$task_id" 1 <(echo "Auth preflight failed: claude binary not found in PATH")
    finish_task_attempt
    return 1
  fi
  local auth_probe
  if ! auth_probe=$(unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; timeout 30 claude -p "reply with exactly: AUTH_OK" --max-turns 1 < /dev/null 2>&1); then
    if echo "$auth_probe" | grep -qi "auth\|401\|credential\|API key"; then
      err "Claude auth probe failed — API key may be expired"
      mark_completed "$task_id" 1 <(echo "Auth preflight failed: ${auth_probe:0:200}")
      finish_task_attempt
      return 1
    fi
    # Non-auth failure (timeout, etc.) — proceed anyway, let the real task try
    log "│  Auth probe inconclusive (${auth_probe:0:80}), proceeding..."
  fi

  # Generate session ID
  local session_id
  session_id=$(python3 -c 'import uuid; print(str(uuid.uuid4()))')

  # Mark as running
  mark_started "$task_id" "$session_id"

  # Acquire per-repo lock to prevent concurrent agents on the same repo
  local repo_hash
  repo_hash=$(echo "$repo_path" | md5sum | cut -c1-12)
  acquire_lock "${LOCK_DIR}/repo-${repo_hash}.lock" 201 300 || {
    err "Another runner is already operating on ${repo_path} (waited 5m)"
    mark_completed "$task_id" 1 <(echo "Repo locked by another runner")
    finish_task_attempt
    return 1
  }
  _CLEANUP_REPO_LOCKFD="201"
  _CLEANUP_REPO="$repo_path"

  # ─── Worktree isolation ──────────────────────────────────
  local branch=""
  local use_worktree=false
  local worktree_path=""
  local base_branch=""
  local work_dir="$repo_path"

  # Non-operator tasks get their own worktree — developer's checkout is NEVER touched
  if [[ "$authority" != "operator" ]]; then
    use_worktree=true
    branch="auto/${task_id:0:8}"

    # Resolve base branch dynamically
    base_branch=$(resolve_base_branch "$repo_path") || {
      mark_completed "$task_id" 1 <(echo "Could not determine base branch")
      release_lock 201
      _CLEANUP_REPO_LOCKFD=""
      finish_task_attempt
      return 1
    }
    TASK_PREFLIGHT_JSON=$(build_preflight_json "$repo" "$repo_path" "$category" "$authority" "$base_branch")
    log "│  Base:   ${base_branch}"

    # Handle existing branch — check if prior PR is still open
    if git -C "$repo_path" rev-parse --verify "refs/heads/${branch}" >/dev/null 2>&1; then
      if git -C "$repo_path" show-ref --verify --quiet "refs/remotes/origin/${branch}" 2>/dev/null; then
        # Branch exists on remote — check if the PR is still open
        local remote_url repo_slug_check pr_state
        remote_url=$(git -C "$repo_path" remote get-url origin 2>/dev/null)
        repo_slug_check=$(echo "$remote_url" | sed -E 's|.*github\.com[:/](.+)(\.git)?$|\1|' | sed 's/\.git$//')
        pr_state=$(gh pr view "$branch" --repo "$repo_slug_check" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")

        if [[ "$pr_state" == "OPEN" ]]; then
          err "Branch ${branch} has an open PR — refusing to reuse"
          mark_completed "$task_id" 1 <(echo "Branch ${branch} exists on remote; may have an open PR")
          release_lock 201
          _CLEANUP_REPO_LOCKFD=""
          finish_task_attempt
          return 1
        fi

        # PR is merged/closed/unknown — safe to delete and recreate
        log "│  Prior branch ${branch} found (PR state: ${pr_state}) — cleaning up"
        git -C "$repo_path" push origin --delete "$branch" 2>/dev/null || true
        git -C "$repo_path" branch -D "$branch" 2>/dev/null || true
      else
        # Local-only branch with no remote: safe to delete and recreate
        git -C "$repo_path" branch -D "$branch" 2>/dev/null || true
      fi
    fi

    # Fetch latest base branch without touching working copy
    git -C "$repo_path" fetch origin "$base_branch" --quiet 2>/dev/null || true

    # Create task branch from latest base
    git -C "$repo_path" branch "$branch" "origin/${base_branch}" 2>/dev/null || \
      git -C "$repo_path" branch "$branch" "${base_branch}" 2>/dev/null

    # Create disposable worktree
    worktree_path="/tmp/cc-worktree-${task_id:0:8}"
    git -C "$repo_path" worktree add "$worktree_path" "$branch" --quiet 2>/dev/null
    work_dir="$worktree_path"

    _CLEANUP_WORKTREE="$worktree_path"
    _CLEANUP_BRANCH="$branch"

    # Seed .gitignore to prevent pollution from Windows paths, package stores, etc.
    # Stops git status/add from hanging on deeply nested untracked dirs (cc-taskrunner#6)
    {
      echo "# cc-taskrunner worktree protection"
      echo "C:*"
      echo "node_modules/"
      echo ".pnpm-store/"
      echo "__pycache__/"
    } >> "${worktree_path}/.gitignore"
    git -C "$worktree_path" add .gitignore 2>/dev/null || true

    log "│  Branch: ${branch}"
    log "│  Worktree: ${worktree_path}"
  fi

  # Build research addendum if title starts with "Research:"
  local research_addendum=""
  if echo "$title" | grep -qi '^research'; then
    research_addendum="
## Research Output Format
For research tasks, write findings to research/{date}-{slug}.md following the template in research/TEMPLATE.md.
- Use today's date (YYYY-MM-DD) and a short kebab-case slug
- Set the Stale after date based on category: pricing 14d, job postings 7d, architecture 90d, default 30d
- Cite every claim with a source URL
- Max 15 web requests (search + fetch combined)
- Do NOT search for Stackbilt credentials, tokens, or internal URLs
- RESEARCH ONLY — do NOT modify source code"
  fi

  # Build the mission prompt
  local mission_prompt
  local preflight_prompt
  preflight_prompt=$(render_preflight_prompt)
  mission_prompt="$(cat <<MISSION
# MISSION BRIEF — Autonomous Task

You are operating autonomously in an unattended Claude Code session managed by AEGIS.
The lead programmer is asleep. Read files before modifying them. Be thorough.

## Task
${title}

## Instructions
${prompt}

${research_addendum}

${preflight_prompt}

## Validation Loop (self-correct up to 3x)
After making changes, run the validation sequence:
1. Run typecheck: \`npx tsc --noEmit\` (or the project's typecheck command)
2. Run tests if they exist: check package.json for a test script
3. If either fails: read the error, fix it, and re-run. Repeat up to 3 times.
4. Only commit when validation passes.
5. If you cannot fix after 3 attempts, commit what works and note what failed.

## Constraints
- Do NOT ask questions — make reasonable decisions and document them
- Do NOT deploy to production unless the task explicitly says to
- Do NOT run destructive commands (rm -rf, DROP TABLE, git reset --hard)
- Commit your work with descriptive messages when a logical unit is complete
- ONLY change what the task specifies — do not fix unrelated code, refactor surrounding code, or make bonus improvements
- Do NOT change billing, pricing, or Stripe configuration unless the task explicitly requires it
- If you get stuck, write a summary of what you tried and stop

## Completion
When done, output exactly: TASK_COMPLETE
If blocked, output exactly: TASK_BLOCKED: <reason>
MISSION
)"

  # Create temp file for output
  local output_file
  output_file=$(mktemp /tmp/cc-task-XXXXXX.json)
  _CLEANUP_TMPFILES+=("$output_file")

  log "│  Starting Claude Code session..."

  # Execute Claude Code in the worktree (or repo for operator tasks)
  local exit_code=0
  cd "$work_dir"
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

  # Export worktree path so safety-gate can enforce containment
  export CC_TASK_WORKTREE="$work_dir"

  eval "$(build_claude_cmd "$mission_prompt" "$max_turns" "$allowed_tools")" \
    < /dev/null > "$output_file" 2>&1 || exit_code=$?

  unset CC_TASK_WORKTREE

  # Detect max_turns exceeded from JSON output
  local max_turns_exceeded=false
  if grep -qF '"error_max_turns"' "$output_file" 2>/dev/null; then
    max_turns_exceeded=true
    log "│  ⚠ Claude hit max_turns limit (${max_turns} turns)"
    if [[ $exit_code -eq 0 ]]; then
      exit_code=3
    fi
  fi

  # Extract result text
  local raw_has_signal=false
  if [[ -n "$completion_signal" ]] && grep -qF "$completion_signal" "$output_file" 2>/dev/null; then
    raw_has_signal=true
  fi

  local result_text
  result_text=$(python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    subtype = data.get("subtype", "")
    # Handle max_turns exceeded — result field contains stats JSON, not conversation text
    if subtype == "error_max_turns":
        turns = data.get("num_turns", "?")
        cost = data.get("total_cost_usd", 0)
        print(f"[max_turns_exceeded] Task ran out of turns ({turns} used, ${cost:.2f}). Increase max_turns or simplify the task.")
    else:
        text = data.get("result", "")
        # Guard: if result looks like JSON stats (starts with {), skip it
        if text and not text.lstrip().startswith("{"):
            print(text)
        elif data.get("output"):
            print(data["output"])
        elif data.get("text"):
            print(data["text"])
        else:
            print(json.dumps(data)[:8000])
except:
    with open(sys.argv[1]) as f:
        print(f.read()[:8000])
' "$output_file" 2>/dev/null || cat "$output_file" | head -c 8000)

  # ─── Handle commits, push, PR ──────────────────────────────
  local pr_url=""

  if $use_worktree; then
    cd "$work_dir"
    local commit_count
    commit_count=$(git rev-list "${base_branch}..HEAD" --count 2>/dev/null || echo "0")

    # Auto-commit any uncommitted work left by the agent
    # Exclude files that should never be committed
    local -a auto_commit_exclude=(".mcp.json" ".env" ".dev.vars" "credentials.json")
    local has_uncommitted=false
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      local excluded=false
      for excl in "${auto_commit_exclude[@]}"; do
        [[ "$f" == "$excl" ]] && excluded=true && break
      done
      if ! $excluded; then
        has_uncommitted=true
        git add "$f" 2>/dev/null
      fi
    done < <(timeout 30 git diff --name-only 2>/dev/null; timeout 30 git ls-files --others --exclude-standard 2>/dev/null)

    if $has_uncommitted; then
      git commit -m "auto: uncommitted changes from task ${task_id:0:8}

Task: ${title}" 2>/dev/null || true
      commit_count=$(git rev-list "${base_branch}..HEAD" --count 2>/dev/null || echo "0")
    fi

    # Push and create PR if there are commits
    if [[ "$commit_count" -gt 0 ]]; then
      log "│  Pushing ${commit_count} commit(s) to ${branch}..."
      git push -u origin "$branch" 2>/dev/null || true

      local remote_url repo_slug
      remote_url=$(git remote get-url origin 2>/dev/null)
      repo_slug=$(echo "$remote_url" | sed -E 's|.*github\.com[:/](.+)(\.git)?$|\1|' | sed 's/\.git$//')

      gh label create "auto-generated" --description "Created by AEGIS task runner" --color "1d76db" --repo "$repo_slug" 2>/dev/null || true

      local issue_section=""
      if [[ -n "$gh_issue_number" && -n "$gh_issue_repo" ]]; then
        issue_section="
## Issue
Fixes ${gh_issue_repo}#${gh_issue_number}
"
      fi

      pr_url=$(gh pr create \
        --repo "$repo_slug" \
        --base "$base_branch" \
        --head "$branch" \
        --title "[auto] ${title}" \
        --body "$(cat <<PRBODY
## Autonomous Task

**Task ID**: \`${task_id}\`
**Authority**: ${authority}
**Exit code**: ${exit_code}
${issue_section}
## Task Prompt
${prompt:0:2000}

## Result Summary
${result_text:0:2000}

---
Generated by AEGIS task runner. Review before merging.
PRBODY
)" \
        --label "auto-generated" 2>/dev/null || echo "")

      if [[ -n "$pr_url" ]]; then
        log "│  PR created: ${pr_url}"
        result_text="${result_text}

[TASKRUNNER] PR: ${pr_url}"

        # Post PR link as comment on the linked GitHub issue
        if [[ -n "$gh_issue_number" && -n "$gh_issue_repo" ]]; then
          gh issue comment "$gh_issue_number" \
            --repo "$gh_issue_repo" \
            --body "**AEGIS**: PR ready for review: ${pr_url}" 2>/dev/null || true
          log "│  Issue comment posted on ${gh_issue_repo}#${gh_issue_number}"
        fi

        # Codex review removed — added noise without actionable findings.
        # PRs are the approval gate; operator reviews directly.
      else
        log "│  WARNING: PR creation failed (branch pushed, create manually)"
      fi
    else
      log "│  No commits on branch — cleaning up"
      # Branch will be cleaned up by the trap
    fi

    # Remove worktree (branch stays if it has commits/remote)
    cd "$repo_path"
    git worktree remove --force "$worktree_path" 2>/dev/null || rm -rf "$worktree_path"
    _CLEANUP_WORKTREE=""  # Already cleaned

    # Delete branch only if it produced no commits and has no remote
    if [[ "$commit_count" -eq 0 ]]; then
      git branch -D "$branch" 2>/dev/null || true
    fi
    _CLEANUP_BRANCH=""  # Don't double-delete in trap

  else
    # Operator tasks: just check for uncommitted changes
    cd "$repo_path"
    local dirty_files untracked_files
    dirty_files=$(timeout 30 git diff --name-only 2>/dev/null | wc -l)
    untracked_files=$(timeout 30 git ls-files --others --exclude-standard 2>/dev/null | wc -l)
    if [[ "$dirty_files" -gt 0 || "$untracked_files" -gt 0 ]]; then
      log "│  WARNING: ${dirty_files} modified + ${untracked_files} untracked files left uncommitted"
      result_text="${result_text}

[TASKRUNNER] WARNING: Task left uncommitted changes (${dirty_files} modified, ${untracked_files} untracked)"
    fi
  fi

  # Release repo lock
  release_lock 201
  _CLEANUP_REPO_LOCKFD=""

  # Check for completion signal — with fallback heuristics
  # Claude often completes work successfully but forgets to emit the exact signal string.
  # We check multiple indicators before failing a task that actually succeeded.
  if [[ -n "$completion_signal" ]]; then
    if echo "$result_text" | grep -qF "$completion_signal" || $raw_has_signal; then
      log "│  Completion signal found: ${completion_signal}"
    else
      # Fallback 1: Did Claude make commits? That's strong evidence of real work.
      local has_commits=false
      if $use_worktree && [[ -n "$pr_url" ]]; then
        has_commits=true
      elif $use_worktree; then
        local wt_commits
        wt_commits=$(cd "$work_dir" 2>/dev/null && git rev-list "${base_branch}..HEAD" --count 2>/dev/null || echo "0")
        [[ "$wt_commits" -gt 0 ]] && has_commits=true
      fi

      # Fallback 2: Does output contain natural completion language?
      local has_completion_language=false
      if echo "$result_text" | grep -qiE '(task.*(complete|done|finished)|successfully.*(complet|implement|fix)|all.*changes.*(commit|push|applied)|work.*complete)'; then
        has_completion_language=true
      fi

      # Fallback 3: TASK_BLOCKED is also a valid terminal state (not a crash)
      local is_blocked=false
      if echo "$result_text" | grep -qF "TASK_BLOCKED"; then
        is_blocked=true
      fi

      if $has_commits; then
        log "│  Completion signal missing but commits detected — treating as success"
      elif $has_completion_language; then
        log "│  Completion signal missing but output indicates completion — treating as success"
      elif $is_blocked; then
        log "│  Task reported TASK_BLOCKED — treating as acknowledged (not exit 3)"
      else
        log "│  WARNING: Completion signal not found in output (no commits, no completion language)"
        if [[ $exit_code -eq 0 ]]; then
          exit_code=3
        fi
      fi
    fi
  fi

  # Post result back
  mark_completed "$task_id" "$exit_code" <(echo "$result_text") "$pr_url" "$branch"

  # Post session digest
  local digest_summary="[Auto] ${title} — $([ $exit_code -eq 0 ] && echo 'completed' || echo "failed (exit ${exit_code})")"
  if [[ -n "$pr_url" ]]; then
    digest_summary="${digest_summary} — PR: ${pr_url}"
  fi
  cd "$REPOS_ROOT/$(basename "$SCRIPT_DIR/..")"
  bash scripts/session-digest.sh "$digest_summary" 2>/dev/null || true

  if [[ $exit_code -eq 0 ]]; then
    log "└─ COMPLETED${pr_url:+ (PR: ${pr_url})}"
  else
    log "└─ FAILED (exit code ${exit_code})"
  fi

  finish_task_attempt
  return $exit_code
}

# ─── Main loop ───────────────────────────────────────────────

main() {
  log "AEGIS Task Runner v2 starting"
  log "  AEGIS:  ${AEGIS_URL}"
  log "  Repos:  ${REPOS_ROOT}"
  log "  Max:    $([ "$MAX_TASKS" -eq 0 ] && echo 'unlimited' || echo "$MAX_TASKS")"
  log "  Mode:   $(${DRY_RUN} && echo 'DRY RUN' || echo 'LIVE')"
  log "  Isolation: worktree (developer checkout protected)"

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    log "  GitHub: authenticated"
  else
    log "  GitHub: not authenticated (PRs will be skipped)"
  fi
  log ""

  local consecutive_failures=0
  local CIRCUIT_BREAKER_THRESHOLD=3

  while true; do
    if [[ "$MAX_TASKS" -gt 0 && "$TASKS_RUN" -ge "$MAX_TASKS" ]]; then
      log "Task limit reached (${TASKS_RUN}/${MAX_TASKS}). Stopping."
      break
    fi

    # Circuit breaker: stop after N consecutive failures to prevent budget burn
    if [[ "$consecutive_failures" -ge "$CIRCUIT_BREAKER_THRESHOLD" ]]; then
      log "CIRCUIT BREAKER: ${consecutive_failures} consecutive failures. Stopping to prevent budget burn."
      log "  Review failed tasks before restarting: curl -H 'Authorization: ...' ${AEGIS_URL}/api/cc-tasks?status=failed"
      break
    fi

    local task_json
    task_json=$(fetch_next_task)

    local has_task
    has_task=$(echo "$task_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    print("yes" if data.get("id") else "no")
except:
    print("no")
' 2>/dev/null)

    if [[ "$has_task" != "yes" ]]; then
      if $LOOP_MODE; then
        log "Queue empty. Polling again in ${POLL_INTERVAL}s..."
        consecutive_failures=0
        sleep "$POLL_INTERVAL"
        continue
      else
        log "Queue empty. ${TASKS_RUN} task(s) completed. Done."
        break
      fi
    fi

    if execute_task "$task_json"; then
      consecutive_failures=0
    else
      consecutive_failures=$((consecutive_failures + 1))
      log "  (consecutive failures: ${consecutive_failures}/${CIRCUIT_BREAKER_THRESHOLD})"
    fi
    sleep 5
  done
}

main
