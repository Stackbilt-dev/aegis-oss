#!/usr/bin/env bash
# deploy.sh — Self-healing deploy pipeline using headless Claude Code
#
# AEGIS deploy pipeline.
# Orchestrates: pre-deploy audit → deploy → verify → rollback on failure.
#
# Usage:
#   ./scripts/deploy.sh              # Full deploy pipeline
#   ./scripts/deploy.sh --dry-run    # Audit only, no deploy
#   ./scripts/deploy.sh --skip-audit # Deploy without pre-deploy audit
#   ./scripts/deploy.sh --force      # Skip audit + skip version verification
#
# Environment:
#   AEGIS_URL        — AEGIS endpoint (default: https://your-aegis-instance.example.com)
#   AEGIS_TOKEN      — Auth token for session digest
#   HEALTH_URL       — Health endpoint to verify (default: https://your-aegis-instance.example.com/health)
#   WORKER_DIR       — Worker source directory (default: web)
#   MAX_TURNS        — Max Claude turns for audit (default: 10)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKER_DIR="${WORKER_DIR:-web}"
WORKER_PATH="${PROJECT_ROOT}/${WORKER_DIR}"
HEALTH_URL="${HEALTH_URL:-https://your-aegis-instance.example.com/health}"
AEGIS_URL="${AEGIS_URL:-https://your-aegis-instance.example.com}"
AEGIS_TOKEN="${AEGIS_TOKEN:-YOUR_AEGIS_TOKEN}"
DEPLOY_SETTINGS="${SCRIPT_DIR}/hooks/deploy-settings.json"
MAX_TURNS="${MAX_TURNS:-10}"

DRY_RUN=false
SKIP_AUDIT=false
FORCE=false

# ─── Parse args ──────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=true; shift ;;
    --skip-audit)  SKIP_AUDIT=true; shift ;;
    --force)       SKIP_AUDIT=true; FORCE=true; shift ;;
    *)             echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
err()  { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }
ok()   { echo "[$(date '+%H:%M:%S')] ✓ $*"; }
fail() { echo "[$(date '+%H:%M:%S')] ✗ $*" >&2; }

# Post deploy result to AEGIS as a session digest
post_digest() {
  local summary="$1"
  bash "${SCRIPT_DIR}/session-digest.sh" "$summary" 2>/dev/null || true
}

# ─── Step 0: Environment validation ─────────────────────────

log "Deploy pipeline starting"
log "Worker: ${WORKER_DIR}/ → ${HEALTH_URL}"

if [[ ! -d "$WORKER_PATH" ]]; then
  fail "Worker directory not found: ${WORKER_PATH}"
  exit 1
fi

# Ensure wrangler auth is available
cd "$WORKER_PATH"
if [[ -f "${PROJECT_ROOT}/.dev.vars" ]]; then
  export $(grep CLOUDFLARE_API_TOKEN "${PROJECT_ROOT}/.dev.vars" | tr -d '\r' | xargs)
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  fail "CLOUDFLARE_API_TOKEN not set. Run: export \$(grep CLOUDFLARE_API_TOKEN .dev.vars | tr -d '\\r' | xargs)"
  exit 1
fi

# ─── Step 1: Capture current deployed version ───────────────

log "Checking current deployed version..."
CURRENT_VERSION=$(curl -s -m 10 -H "Accept: application/json" "${HEALTH_URL}" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' 2>/dev/null || echo "unknown")
log "Current deployed version: ${CURRENT_VERSION}"

# Read expected version from source
EXPECTED_VERSION=$(grep -oP "VERSION = '([^']+)'" "${WORKER_PATH}/src/version.ts" | grep -oP "'[^']+" | tr -d "'")
log "Expected version (source): ${EXPECTED_VERSION}"

if [[ "$CURRENT_VERSION" == "$EXPECTED_VERSION" && "$FORCE" != "true" ]]; then
  log "Source version matches deployed version. Nothing to deploy."
  log "Bump version.ts before deploying, or use --force to redeploy."
  exit 0
fi

# ─── Step 2: Pre-deploy audit (headless Claude) ─────────────

if [[ "$SKIP_AUDIT" != "true" ]]; then
  log "Running pre-deploy audit..."

  AUDIT_PROMPT="You are running a pre-deploy audit for a Cloudflare Worker (${WORKER_DIR}/).

Run these checks and report results:
1. Run the typecheck: cd ${WORKER_PATH} && npm run typecheck
2. Check for uncommitted changes: git status --porcelain (from project root ${PROJECT_ROOT})
3. Verify version.ts has been bumped (current deployed: ${CURRENT_VERSION}, source: ${EXPECTED_VERSION})
4. Check CHANGELOG.md has an entry for version ${EXPECTED_VERSION}

Report a PASS/FAIL verdict for each check. If ANY check fails, end your response with:
VERDICT: FAIL

If all checks pass, end with:
VERDICT: PASS

Be concise. No explanations unless something fails."

  # Strip nesting guard so headless claude can launch from within a CC session
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

  AUDIT_OUTPUT=$(claude -p "$AUDIT_PROMPT" \
    --allowedTools "Bash,Read,Grep,Glob" \
    --max-turns "$MAX_TURNS" \
    --output-format text \
    2>&1) || {
    err "Headless audit failed to execute"
    AUDIT_OUTPUT="VERDICT: FAIL (claude execution error)"
  }

  echo "$AUDIT_OUTPUT"

  if echo "$AUDIT_OUTPUT" | grep -qiE "VERDICT:.*FAIL"; then
    fail "Pre-deploy audit failed. Fix issues above before deploying."
    if [[ "$DRY_RUN" == "true" ]]; then
      log "(dry-run mode — this is informational)"
      exit 0
    fi
    exit 1
  fi

  ok "Pre-deploy audit passed"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "(dry-run mode — skipping deploy)"
    exit 0
  fi
else
  if [[ "$DRY_RUN" == "true" ]]; then
    log "(dry-run mode with --skip-audit — nothing to do)"
    exit 0
  fi
  log "Skipping pre-deploy audit (--skip-audit)"
fi

# ─── Step 3: Deploy ─────────────────────────────────────────

log "Deploying ${WORKER_DIR}/ to Cloudflare..."
cd "$WORKER_PATH"

DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1) || {
  fail "wrangler deploy failed"
  echo "$DEPLOY_OUTPUT"
  post_digest "Deploy FAILED for ${WORKER_DIR}/ v${EXPECTED_VERSION} — wrangler deploy error"
  exit 1
}

ok "wrangler deploy succeeded"
echo "$DEPLOY_OUTPUT" | tail -5

# ─── Step 4: Post-deploy verification ───────────────────────

if [[ "$FORCE" != "true" ]]; then
  log "Waiting 5s for deployment to propagate..."
  sleep 5

  log "Verifying deployment..."

  RETRIES=3
  VERIFIED=false

  for i in $(seq 1 $RETRIES); do
    DEPLOYED_VERSION=$(curl -s -m 10 -H "Accept: application/json" "${HEALTH_URL}" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' 2>/dev/null || echo "unknown")

    if [[ "$DEPLOYED_VERSION" == "$EXPECTED_VERSION" ]]; then
      VERIFIED=true
      break
    fi

    if [[ $i -lt $RETRIES ]]; then
      log "Version mismatch (got ${DEPLOYED_VERSION}, expected ${EXPECTED_VERSION}), retrying in 5s... (${i}/${RETRIES})"
      sleep 5
    fi
  done

  if [[ "$VERIFIED" == "true" ]]; then
    ok "Deployment verified: v${DEPLOYED_VERSION} live at ${HEALTH_URL}"
    post_digest "Deploy SUCCESS: ${WORKER_DIR}/ v${EXPECTED_VERSION} verified at ${HEALTH_URL}"
  else
    fail "Deployment verification failed!"
    fail "Expected: ${EXPECTED_VERSION}, Got: ${DEPLOYED_VERSION}"
    log ""
    log "The deploy ran but /health does not reflect the new version."
    log "Possible causes: CDN cache, version.ts not bumped, deploy targeted wrong worker."
    log ""
    log "To rollback: npx wrangler rollback (from ${WORKER_DIR}/)"
    post_digest "Deploy WARNING: ${WORKER_DIR}/ v${EXPECTED_VERSION} deployed but verification returned ${DEPLOYED_VERSION}"
    exit 1
  fi
else
  log "Skipping verification (--force)"
  ok "Deploy completed (unverified)"
  post_digest "Deploy FORCE: ${WORKER_DIR}/ v${EXPECTED_VERSION} deployed without verification"
fi

# ─── Done ────────────────────────────────────────────────────

log "Deploy pipeline complete"
