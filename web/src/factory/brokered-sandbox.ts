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

function githubToken(env: BrokerEnv): string {
  return env.GITHUB_TOKEN_SCOPED ?? env.GITHUB_TOKEN ?? '';
}

export class BrokeredSandbox extends Sandbox<BrokerEnv> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [...SANDBOX_EGRESS_HOSTS];
}

const readOnly = (request: Request) => brokerReadOnlyRequest(request);

// Assigned here, not as `static` class fields: a field would define its own
// property and skip the inherited setters that register these handlers, leaving
// every allowed host with direct, unbrokered access.
BrokeredSandbox.outboundHandlers = {
  [GITHUB_SCOPED_HANDLER]: (request: Request, env: unknown, ctx: { params?: unknown }) =>
    brokerGitHubRequest(request, githubToken(env as BrokerEnv), (ctx.params as GitHubEgressScope | undefined) ?? EMPTY_GITHUB_SCOPE),
};
BrokeredSandbox.outboundByHost = {
  ...Object.fromEntries(SANDBOX_EGRESS_HOSTS.map((host) => [host, readOnly])),
  // Until the executor sets the task's scope, github.com is public reads only.
  'github.com': (request: Request, env: unknown) =>
    brokerGitHubRequest(request, githubToken(env as BrokerEnv), EMPTY_GITHUB_SCOPE),
};
