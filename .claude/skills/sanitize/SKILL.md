---
name: sanitize
description: Scan for leaked internal references in the OSS repo
user_invocable: true
---

Run the sanitizer agent to check for leaked internal content:

Use the `sanitizer` agent to scan the codebase. Patterns to check:

```bash
# Check for internal .workers.dev URLs
grep -rn "blue-pine-edf6\|kurt-5be" --include="*.ts" --include="*.md" .

# Check for internal service names
grep -rn "businessops-copilot\|aegis-daemon\|edgestack" --include="*.ts" --include="*.md" .

# Check for personal references
grep -rn "stackbilt\.dev\|kurtovermier\|Stackbilt-dev/aegis[^-]" --include="*.ts" --include="*.md" --include="*.json" .

# Check for real tokens/secrets patterns
grep -rn "aegis_0536\|sk-ant-\|gsk_\|ghp_\|1SoY-coq" --include="*.ts" --include="*.md" --include="*.json" .
```

Report any findings.
