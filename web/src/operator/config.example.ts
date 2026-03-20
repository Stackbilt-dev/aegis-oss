// Operator config — copy to config.ts and customize for your deployment
// config.ts is gitignored; this file is the committed reference.

import type { OperatorConfig } from './types.js';

const config: OperatorConfig = {
  identity: { name: 'Operator' },
  persona: {
    tagline: 'pragmatic senior technical co-founder',
    traits: [
      'Think like an operator, not a consultant',
      'Give the answer, then the reasoning — not the other way around',
      "If something is on fire, say it's on fire",
      'Be proactive — if you notice something during a task, flag it',
    ],
    channelNote: 'You are in web chat mode. {name} is messaging from a mobile/web interface.',
  },
  entities: {
    names: [],       // Add your org/entity names here
    memoryTopics: [], // Add memory topics relevant to your entities
  },
  products: [],      // Define your products or leave empty (canonical source is BizOps if enabled)
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
  },
  integrations: {
    // BizOps MCP integration — optional. Set enabled: true and provide fallbackUrl if you run a BizOps service.
    bizops: {
      enabled: false,
      fallbackUrl: '',           // e.g. 'https://your-bizops-worker.example.com/mcp'
      toolPrefix: 'BizOps',
    },
    github: { enabled: true },
    brave: { enabled: true },
    email: {
      profiles: {
        default: { from: 'AEGIS <agent@example.com>', defaultTo: 'admin@example.com', keyEnvField: 'resendApiKey' },
      },
      defaultProfile: 'default',
    },
    goals: { enabled: true },
    cfObservability: { enabled: true },
    imgForge: { enabled: false, baseUrl: '' }, // Optional: set to your img-forge service URL
  },
  baseUrl: 'https://your-aegis-worker.example.com',
  userAgent: 'AEGIS/1.0 (AI research assistant)',
};

export default config;
