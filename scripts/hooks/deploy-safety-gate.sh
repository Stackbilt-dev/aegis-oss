#!/usr/bin/env bash
# deploy-safety-gate.sh — Safety gate for deploy pipeline
#
# Allows: wrangler deploy, curl (health checks), npm run typecheck
# Blocks: destructive ops, secret management, git force pushes

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

if [[ "$TOOL" != "Bash" ]]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Destructive filesystem operations
if echo "$CMD" | grep -qiE '(rm\s+-rf|rm\s+-r\s+/|>\s*/dev/)'; then
  echo "BLOCKED: Destructive filesystem operation not allowed in deploy mode" >&2
  exit 2
fi

# Destructive git operations
if echo "$CMD" | grep -qiE '(git\s+reset\s+--hard|git\s+push\s+--force|git\s+push\s+-f|git\s+clean\s+-f)'; then
  echo "BLOCKED: Destructive git operation not allowed in deploy mode" >&2
  exit 2
fi

# Database destruction
if echo "$CMD" | grep -qiE '(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*$)'; then
  echo "BLOCKED: Destructive database operation not allowed in deploy mode" >&2
  exit 2
fi

# Secret management
if echo "$CMD" | grep -qiE '(wrangler\s+secret|echo\s+.*API_KEY|echo\s+.*TOKEN|echo\s+.*SECRET)'; then
  echo "BLOCKED: Secret management not allowed in deploy mode" >&2
  exit 2
fi

# Code modification (deploy pipeline should not edit source code)
if echo "$CMD" | grep -qiE '(sed\s+-i|awk.*-i\s+inplace)'; then
  echo "BLOCKED: Code modification not allowed in deploy mode" >&2
  exit 2
fi

exit 0
