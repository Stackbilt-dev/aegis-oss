# AEGIS 0.8.0 Proof of Work

Date: 2026-06-02

AEGIS 0.8.0 is the first release where the OSS repo is no longer just a kernel package plus API routes. A fresh checkout can build and dry-run a self-contained Cloudflare Worker with an embedded browser console, voice adapter, D1-backed state, Workers AI, and the terminal CLI surface.

## What Shipped

- Embedded Vite SPA in `web/public/`
- Browser text chat backed by `/api/message/stream`
- Conversation history backed by D1
- Health summary embedded in the browser console
- Voice panel using `@cloudflare/voice/react`
- `AegisVoiceAdapter` exported by the standalone Worker
- Agents SDK route bridge for `/agents/aegis-voice-adapter/operator`
- Token enforcement for `/agents/*`
- `wrangler.toml.example` with `ASSETS`, `CHAT_SESSION`, `AegisVoiceAdapter`, `DB`, and `AI`
- Published package: `@stackbilt/aegis-core@0.8.0`

## Fresh Checkout Smoke

The clean-checkout smoke used a `git archive HEAD` export into `/tmp`, not the working tree.

```bash
npm install
npm run build:ui
npm run typecheck
cp wrangler.toml.example wrangler.toml
HOME=/tmp XDG_CONFIG_HOME=/tmp npx wrangler deploy --dry-run
```

Result:

```text
env.CHAT_SESSION (ChatSession)                 Durable Object
env.AegisVoiceAdapter (AegisVoiceAdapter)      Durable Object
env.DB (my-agent)                              D1 Database
env.AI                                         AI
env.ASSETS                                     Assets
```

The dry run completed successfully with a total upload of about 2.9 MiB, confirming the Worker entrypoint, static assets, Durable Objects, D1 binding, and Workers AI binding are present in the standalone deployment config.

## Published Package Smoke

The npm package was fetched from the public registry and unpacked in `/tmp`.

```bash
npm pack @stackbilt/aegis-core@0.8.0
tar -xzf stackbilt-aegis-core-0.8.0.tgz
node package/cli/aegis.mjs --help
```

Result:

```text
AEGIS CLI

Usage:
  aegis [--host <host>] [--token <token>] [--exec <executor>] [--conversation <uuid>] [--verbose] [--quick]
```

The tarball includes:

- `cli/aegis.mjs`
- `public/index.html`
- `public/assets/index-*.js`
- `public/assets/index-*.css`
- `schema.sql`
- Worker and kernel TypeScript source

## Release Evidence

- PR: https://github.com/Stackbilt-dev/aegis-oss/pull/67
- Issue: https://github.com/Stackbilt-dev/aegis-oss/issues/40
- Release workflow: https://github.com/Stackbilt-dev/aegis-oss/actions/runs/26834977611
- npm: `@stackbilt/aegis-core@0.8.0`

## Launch Position

AEGIS is now best framed as an opinionated, edge-native persistent agent kit:

- your Cloudflare account
- your D1 database
- your Workers AI binding
- your browser console
- your terminal
- no private Stackbilt UI dependency

The immediate demo path should show one operator moving between browser and terminal against the same Worker deployment: authenticate, inspect health, ask a question, switch to terminal with `npx @stackbilt/aegis-core --quick`, and continue the same agent workflow.
