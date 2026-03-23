#!/usr/bin/env bash
# session-digest.sh — Post a structured Claude Code session digest to AEGIS
# Usage: ./scripts/session-digest.sh "summary of key decisions, changes shipped, and open items"

set -euo pipefail

AEGIS_URL="${AEGIS_URL:-https://your-aegis-instance.example.com}"
AEGIS_TOKEN="${AEGIS_TOKEN:-YOUR_AEGIS_TOKEN}"

# Accept summary from argument or stdin
if [[ $# -gt 0 ]]; then
  SUMMARY="$*"
else
  SUMMARY=$(cat)
fi

if [[ -z "$SUMMARY" ]]; then
  echo "Error: No session summary provided" >&2
  echo "Usage: $0 \"summary of key decisions, changes shipped, and open items\"" >&2
  exit 1
fi

# Collect structured data from git
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"

# Recent commits from this session (last 2 hours)
COMMITS_RAW=$(git log --since="2 hours ago" --format='%h|%s' 2>/dev/null || true)

# Build JSON payload safely via Python (no shell interpolation in strings)
PAYLOAD=$(echo "$COMMITS_RAW" | SUMMARY="$SUMMARY" REPO_NAME="$REPO_NAME" python3 -c '
import json, os, sys

summary = os.environ["SUMMARY"]
repo = os.environ["REPO_NAME"]
commits = []
files = set()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split("|", 1)
    if len(parts) == 2:
        commits.append({"hash": parts[0], "message": parts[1], "repo": repo})

payload = {"summary": summary, "repos": [repo]}
if commits:
    payload["commits"] = commits

print(json.dumps(payload))
')

# Post to structured CC session endpoint
RESPONSE=$(curl -s -m 30 -X POST "${AEGIS_URL}/api/cc-session" \
  -H "Authorization: Bearer ${AEGIS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

echo "$RESPONSE" | python3 -c '
import json, sys
try:
    r = json.load(sys.stdin)
    if "id" in r:
        sid = r["id"]
        sdate = r.get("session_date", "?")
        print(f"Session recorded: {sid} ({sdate})")
    else:
        err = r.get("error", "unknown")
        print(f"Error: {err}")
except:
    print("Digest sent (response parsing skipped)")
'
