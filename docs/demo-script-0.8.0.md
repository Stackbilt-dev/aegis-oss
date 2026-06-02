# AEGIS 0.8.0 Demo Script

This script is the launch-safe path for recording or presenting AEGIS 0.8.0. It demonstrates the two public surfaces that now work from a standalone checkout: the embedded browser console and the package CLI.

## Goal

Show that a developer can install AEGIS, deploy a self-contained Cloudflare Worker, use the browser console, and talk to the same agent from a terminal without private Stackbilt infrastructure.

## Preflight

Run these from `web/` before recording:

```bash
npm install
npm run build:ui
npm run typecheck
cp wrangler.toml.example wrangler.toml
npx wrangler deploy --dry-run
```

The dry run should show the `ASSETS`, `DB`, `AI`, `CHAT_SESSION`, and `AegisVoiceAdapter` bindings.

For the published package smoke:

```bash
npm pack @stackbilt/aegis-core@0.8.0
node package/cli/aegis.mjs --help
```

## Recording Flow

1. Open the Worker root and authenticate with `AEGIS_TOKEN`.
2. Show the health summary in the embedded console.
3. Send one grounded prompt:

   ```text
   What runtime and bindings are you using for this session?
   ```

4. Send one continuity prompt:

   ```text
   Summarize what changed in AEGIS 0.8.0 using only release metadata or health data you can access.
   ```

5. Open the voice panel and establish a call through `/agents/aegis-voice-adapter/operator`.
6. Switch to a terminal and run:

   ```bash
   AEGIS_HOST=your-worker.workers.dev AEGIS_TOKEN=your-token npx @stackbilt/aegis-core --quick
   ```

7. Ask the same release-summary prompt from the terminal to show that the browser and CLI are talking to the same deployed agent.
8. End by showing [proof-of-work-0.8.0.md](proof-of-work-0.8.0.md).

## Trust Guardrails

- Keep the demo to health, release, configuration, memory, agenda, and directly available deployment facts.
- Do not ask for live GitHub, npm, analytics, or production metrics unless the integration is configured and the response includes the tool/source path.
- Treat Claude and Groq as optional upgrades. The base demo should work with `AEGIS_TOKEN`, D1, Workers AI, Durable Objects, and static assets.
- If the agent cannot verify a fact from its configured surfaces, the correct answer is a clarification or limitation, not a guess.

## Success Criteria

- Browser console loads from the Worker root.
- Text chat reaches `/api/message/stream`.
- Voice call reaches `/agents/aegis-voice-adapter/operator`.
- CLI connects with `AEGIS_HOST` and `AEGIS_TOKEN`.
- The agent describes only facts available through release docs, health, memory, or configured tools.
