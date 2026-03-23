// Stub — full implementation not yet extracted to OSS

import { type EdgeEnv } from '../dispatch.js';

export const DEFAULT_WATCH_REPOS = [
  'aegis',
  'demo_app_v2',
  'charter',
  'img-forge',
  'example-auth',
  'bizops-copilot',
];

export function getWatchRepos(githubRepo: string): string[] {
  const org = githubRepo.split('/')[0];
  return DEFAULT_WATCH_REPOS.map(repo => `${org}/${repo}`);
}

export async function runSelfImprovementAnalysis(env: EdgeEnv): Promise<void> {
  throw new Error('not implemented');
}

export async function runSelfImprovementHousekeeping(env: EdgeEnv): Promise<void> {
  throw new Error('not implemented');
}

export async function runInfraComplianceCheck(env: EdgeEnv): Promise<void> {
  throw new Error('not implemented');
}
