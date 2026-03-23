# Configuration

AEGIS is configured through two files in `web/src/operator/`:

- `config.ts` — Identity, integrations, and behavior settings
- `persona.ts` — System prompt template

Both are gitignored. Copy from the `.example` files and customize.

## Operator config

### Identity

```typescript
identity: {
  name: 'Alex',           // Your name — used in prompts and memory
  possessive: "Alex's",   // Optional, auto-derived if omitted
}
```

### Persona

```typescript
persona: {
  tagline: 'pragmatic technical co-founder',  // One-line description of communication style
  traits: [
    'Think like an operator, not a consultant',
    'Give the answer, then the reasoning',
    'Be proactive — flag issues without being asked',
  ],
  channelNote: 'You are in web chat mode. {name} is messaging from a mobile/web interface.',
}
```

The `traits` array feeds directly into the system prompt. Each trait becomes a behavioral instruction.

### Entities

```typescript
entities: {
  names: ['Acme Corp', 'Acme LLC'],     // Your org/entity names
  memoryTopics: ['acme', 'operations'],  // Memory topics to track
}
```

### Products

```typescript
products: [
  {
    name: 'My App',
    description: 'A web application for...',
    model: 'proprietary_saas',  // or 'oss', 'internal', etc.
    status: 'live',             // or 'pre_launch', 'development'
    revenue: '$X MRR',
  },
]
```

Product definitions give the agent context about what you're building. This shapes how it reasons about priorities, decisions, and trade-offs.

### Self model

```typescript
selfModel: {
  identity: 'AEGIS — autonomous cognitive agent',
  role: 'Autonomous operator and technical co-founder',
  stakes: 'Economic alignment with the business',
  principles: ['Operator mindset', 'Revenue awareness', 'Security first'],
  interests: ['AI infrastructure', 'Edge computing'],
  strengths: ['Systems thinking', 'Persistent memory'],
  preferences: {
    communication: 'Direct and opinionated',
    work: 'Ship small increments',
    learning: 'Agent memory and planning architectures',
  },
}
```

The self model tells the agent what kind of agent it is. This affects reasoning, initiative level, and communication style.

### Integrations

```typescript
integrations: {
  bizops: {
    enabled: false,               // BizOps MCP integration
    fallbackUrl: '',              // URL of your BizOps service
    toolPrefix: 'BizOps',
  },
  github: { enabled: true },      // Repository scanning, issue management
  brave: { enabled: true },       // Web research
  email: {
    profiles: {
      default: {
        from: 'AEGIS <agent@example.com>',
        defaultTo: 'admin@example.com',
        keyEnvField: 'resendApiKey',
      },
    },
    defaultProfile: 'default',
  },
  goals: { enabled: true },       // Autonomous goal pursuit
  cfObservability: { enabled: true }, // Cloudflare analytics
  imgForge: { enabled: false, baseUrl: '' }, // Image generation
}
```

Each integration requires its corresponding secret to be set via `wrangler secret put`.

### Base URL

```typescript
baseUrl: 'https://your-aegis-worker.workers.dev',
userAgent: 'AEGIS/1.0 (AI research assistant)',
```

## Persona template

The `persona.ts` file defines the system prompt template. Available placeholders:

| Placeholder | Source |
|-------------|--------|
| `{name}` | `config.identity.name` |
| `{possessive}` | `config.identity.possessive` |
| `{persona_tagline}` | `config.persona.tagline` |
| `{traits}` | `config.persona.traits` (formatted as bullet list) |
| `{bizops_section}` | Auto-generated from BizOps integration state |
| `{channel_note}` | `config.persona.channelNote` |

The default persona template includes instructions for memory recording, agenda management, and proposed actions. Customize the communication style, but keep the memory/agenda sections — they're core to AEGIS functionality.

## Secrets reference

Set via `npx wrangler secret put <NAME>`:

| Secret | Required | Purpose |
|--------|----------|---------|
| `AEGIS_TOKEN` | Yes | Bearer token for chat UI auth |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GROQ_API_KEY` | No | Groq API key for fast classification |
| `GITHUB_TOKEN` | No | GitHub PAT for repo access |
| `BRAVE_API_KEY` | No | Brave Search API key |
| `RESEND_API_KEY` | No | Resend API key for email |

## Service bindings (optional)

Configure in `wrangler.toml` for inter-Worker communication:

```toml
# Memory Worker (persistent semantic memory with vector search)
[[services]]
binding = "MEMORY"
service = "your-memory-worker"
entrypoint = "MemoryService"

# TarotScript (deterministic symbolic reasoning)
[[services]]
binding = "TAROTSCRIPT"
service = "tarotscript-worker"
```
