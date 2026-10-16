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
    bizops: { enabled: boolean; fallbackUrl: string; toolPrefix: string };
    github: {
      enabled: boolean;
      /**
       * PR auto-merge for completed docs/tests/research tasks. A repo merges
       * only when every check named here passed on the PR's head commit
       * (plus every other status and check run that exists). A repo with no
       * entry is never auto-merged. Keys are `owner/name`; names are check
       * run names (GitHub Actions job names) or commit status contexts.
       */
      automerge?: { requiredChecks: Record<string, string[]> };
    };
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
