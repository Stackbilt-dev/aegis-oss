---
name: typecheck
description: Run TypeScript type checking for aegis-oss
user_invocable: true
---

Run the TypeScript compiler in check mode:

```bash
cd web && npm run typecheck 2>&1
```

If there are errors, show them grouped by file. If clean, confirm.
