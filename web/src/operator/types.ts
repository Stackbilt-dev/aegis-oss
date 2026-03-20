export interface Product {
  name: string;
  description: string;
  model: 'proprietary_saas' | 'proprietary_api' | 'oss' | 'internal' | 'non_commercial' | 'client_product';
  status: 'live' | 'pre_launch' | 'development' | 'internal';
  revenue?: string;
}

export interface SelfModel {
  identity: string;
  role: string;
  stakes: string;
  principles: string[];
  interests: string[];
  strengths: string[];
  preferences: {
    communication: string;
    work: string;
    learning: string;
  };
}

export interface OperatorConfig {
  identity: { name: string; possessive?: string };
  persona: { tagline: string; traits: string[]; channelNote: string };
  entities: { names: string[]; memoryTopics: string[] };
  products?: Product[]; // Fallback only — canonical source is BizOps project registry via CognitiveState
  selfModel: SelfModel;
  integrations: {
    bizops: { enabled: boolean; fallbackUrl: string; toolPrefix: string }; // Optional: set enabled=false to disable
    github: { enabled: boolean };
    brave: { enabled: boolean };
    email: {
      profiles: Record<string, { from: string; defaultTo: string; keyEnvField: 'resendApiKey' | 'resendApiKeyPersonal' }>;
      defaultProfile: string;
    };
    goals: { enabled: boolean };
    cfObservability: { enabled: boolean };
    imgForge: { enabled: boolean; baseUrl: string };
  };
  baseUrl: string;
  userAgent: string;
}
