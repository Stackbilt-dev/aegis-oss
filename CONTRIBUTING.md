# Contributing to AEGIS

Thanks for your interest in contributing to AEGIS.

## Getting Started

```bash
cd web
npm install
npm test        # Run the test suite
npm run typecheck  # TypeScript checks
```

## Development

- **Language**: TypeScript, strict mode, ES modules
- **Style**: 2-space indent, single quotes, semicolons
- **Naming**: PascalCase for types/interfaces, camelCase for functions/variables
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`

## Project Structure

```
web/
  src/                 # TypeScript source
    kernel/            # Cognitive kernel (dispatch, routing, memory, scheduled tasks)
    operator/          # Operator config, persona, prompt builder
    routes/            # Hono API routes
    mcp/               # MCP server implementation
  tests/               # Vitest test suite
  schema.sql           # D1 database schema
scripts/               # Deploy, taskrunner, hooks
.ai/                   # ADF governance context
docs/                  # User-facing documentation
```

## What NOT to commit

- `web/wrangler.toml` — contains account-specific IDs (use `wrangler.toml.example`)
- `web/src/operator/config.ts` / `persona.ts` — user customizations (use `.example` files)
- `.dev.vars`, `.env` — secrets
- Account IDs, API tokens, or internal URLs

## Pull Requests

1. Fork the repo and create a feature branch from `main`
2. Write tests for new functionality
3. Ensure `npm test` and `npm run typecheck` pass
4. Use a descriptive PR title following conventional commit format
5. Keep PRs focused — one feature or fix per PR

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, Wrangler version)

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
