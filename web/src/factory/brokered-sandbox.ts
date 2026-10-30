// The Sandbox container class with no credentials inside and a closed network.
// Workers runtime only. Export it from your Worker as `Sandbox`, along with
// ContainerProxy, and set `egressBroker: true` on the task executor.

import { Sandbox } from '@cloudflare/sandbox';
import {
  EMPTY_GITHUB_SCOPE,
  GITHUB_SCOPED_HANDLER,
  SANDBOX_EGRESS_HOSTS,
  brokerGitHubRequest,
  brokerReadOnlyRequest,
  type GitHubEgressScope,
} from './egress.js';

interface BrokerEnv {
  GITHUB_TOKEN?: string;
  GITHUB_TOKEN_SCOPED?: string;
}

function githubToken(env: unknown): string {
  const { GITHUB_TOKEN_SCOPED, GITHUB_TOKEN } = env as BrokerEnv;
  return GITHUB_TOKEN_SCOPED ?? GITHUB_TOKEN ?? '';
}

export interface BrokeredSandboxOptions {
  /** More hosts your installs or tests read from, without credentials. */
  extraReadOnlyHosts?: string[];
}

/**
 * Builds the container class. To add hosts, use this rather than subclassing:
 * handlers are registered per class name, so a subclass would have none.
 */
export function createBrokeredSandbox(options: BrokeredSandboxOptions = {}) {
  const hosts = [...SANDBOX_EGRESS_HOSTS, ...(options.extraReadOnlyHosts ?? [])];

  class BrokeredSandbox extends Sandbox<BrokerEnv> {
    enableInternet = false;
    interceptHttps = true;
    allowedHosts = hosts;
  }

  // Assigned here, not as `static` class fields: a field would define its own
  // property and skip the inherited setters that register these handlers, leaving
  // every allowed host with direct, unbrokered access.
  BrokeredSandbox.outboundHandlers = {
    [GITHUB_SCOPED_HANDLER]: (request: Request, env: unknown, ctx: { params?: unknown }) =>
      brokerGitHubRequest(request, githubToken(env), (ctx.params as GitHubEgressScope | undefined) ?? EMPTY_GITHUB_SCOPE),
  };
  BrokeredSandbox.outboundByHost = {
    ...Object.fromEntries(hosts.map((host) => [host, (request: Request) => brokerReadOnlyRequest(request)])),
    // Until the executor sets a scope, github.com is public reads only.
    'github.com': (request: Request, env: unknown) =>
      brokerGitHubRequest(request, githubToken(env), EMPTY_GITHUB_SCOPE),
  };

  return BrokeredSandbox;
}

export const BrokeredSandbox = createBrokeredSandbox();
