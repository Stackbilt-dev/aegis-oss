# Getting Started

Deploy your own AEGIS agent on Cloudflare Workers in under 10 minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare](https://cloudflare.com) account (free tier works)
- An [Anthropic](https://console.anthropic.com) API key (for Claude)
- Optional: [Groq](https://console.groq.com) API key (free tier available, used for fast classification)

## 1. Clone and install

```bash
git clone https://github.com/Stackbilt-dev/aegis-oss.git
cd aegis-oss/web
npm install
```

## 2. Configure Wrangler

Copy the example config and fill in your Cloudflare account details:

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:
- Uncomment and set `account_id` to your Cloudflare account ID
- Set a `database_name` for your agent (or keep `my-agent`)

## 3. Create the D1 database

```bash
npx wrangler d1 create my-agent
```

This prints a `database_id` — paste it into `wrangler.toml` under `[[d1_databases]]`.

Then run the schema migration:

```bash
npx wrangler d1 execute my-agent --file=schema.sql
```

## 4. Configure your agent's identity

```bash
cp src/operator/config.example.ts src/operator/config.ts
cp src/operator/persona.example.ts src/operator/persona.ts
```

Edit `config.ts` to set your name, persona traits, and which integrations to enable. See [Configuration](configuration.md) for the full reference.

## 5. Set secrets

At minimum, you need an auth token and an AI model key:

```bash
npx wrangler secret put AEGIS_TOKEN            # A random bearer token you'll use to authenticate
npx wrangler secret put ANTHROPIC_API_KEY      # Your Claude API key
```

Optional secrets for additional capabilities:

```bash
npx wrangler secret put GROQ_API_KEY           # Fast classification (Llama 3.3 70B)
npx wrangler secret put GITHUB_TOKEN           # Repository scanning, issue management
npx wrangler secret put BRAVE_API_KEY          # Web research
npx wrangler secret put RESEND_API_KEY         # Email notifications
```

## 6. Deploy

```bash
npx wrangler deploy
```

Your agent is now live at `https://your-worker-name.your-subdomain.workers.dev`.

## 7. Authenticate

Visit your worker URL. You'll be prompted for a bearer token — use the `AEGIS_TOKEN` you set in step 5.

## 8. Verify

Check the health endpoint:

```bash
curl https://your-worker.workers.dev/health
```

You should see the version number and system status.

## Local development

For local development without deploying:

```bash
# Create a .dev.vars file with your secrets
cat > ../.dev.vars << 'EOF'
AEGIS_TOKEN=test-token
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
EOF

# Run locally
npx wrangler dev
```

## Next steps

- [Architecture](architecture.md) — understand the cognitive kernel
- [Configuration](configuration.md) — customize your agent's behavior
- [Memory System](memory-system.md) — how AEGIS remembers and learns
