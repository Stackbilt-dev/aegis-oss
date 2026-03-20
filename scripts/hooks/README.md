# Task Runner Safety Hooks

These hooks enforce safety constraints during autonomous (unattended) Claude Code sessions run by the [task runner](../taskrunner.sh). They prevent destructive operations, interactive prompts, and catch TypeScript errors early — so the lead programmer can sleep while tasks execute safely.

## Configuration

`autonomous-settings.json` is the Claude Code `--settings` file that registers all hooks. The task runner passes it via `--settings` automatically.

## Hook Scripts

| Script | Hook Type | Trigger | What It Does |
|--------|-----------|---------|--------------|
| `block-interactive.sh` | `PreToolUse` | `AskUserQuestion` | Blocks the `AskUserQuestion` tool so Claude makes autonomous decisions instead of waiting for human input that will never come. |
| `safety-gate.sh` | `PreToolUse` | `Bash` | Blocks dangerous shell commands: destructive filesystem ops (`rm -rf`), destructive git ops (`push --force`, `reset --hard`), database destruction (`DROP TABLE`), production deploys (`wrangler deploy`), and secret management. |
| `syntax-check.sh` | `PostToolUse` | `Edit`, `Write` | After any TypeScript/JavaScript file is edited, runs `tsc --noEmit` against the nearest `tsconfig.json` and warns if errors are detected. Advisory only — never blocks. |

## Exit Codes

- `0` — Allow the tool call (or advisory success)
- `2` — Block the tool call (PreToolUse hooks only)
