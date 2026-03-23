import type { EdgeEnv } from './kernel/dispatch.js';
import type { Env } from './types.js';
import { operatorConfig } from './operator/index.js';

export function buildEdgeEnv(env: Env, ctx?: ExecutionContext): EdgeEnv {
  const gatewayId = env.AI_GATEWAY_ID || '';

  // When AI Gateway is configured, route LLM calls through it for observability/caching
  let anthropicBaseUrl = 'https://api.anthropic.com';
  let groqBaseUrl = 'https://api.groq.com';
  if (gatewayId) {
    const accountId = env.CF_ACCOUNT_ID;
    const gwBase = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
    anthropicBaseUrl = `${gwBase}/anthropic`;
    groqBaseUrl = `${gwBase}/groq`;
  }

  return {
    db: env.DB,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    opusModel: env.CLAUDE_OPUS_MODEL || 'claude-opus-4-6',
    gptOssModel: env.GPT_OSS_MODEL || '@cf/openai/gpt-oss-120b',
    groqApiKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqResponseModel: env.GROQ_RESPONSE_MODEL || 'llama-3.1-8b-instant',
    groqGptOssModel: env.GROQ_GPT_OSS_MODEL || 'openai/gpt-oss-120b',
    bizopsFetcher: env.BIZOPS,
    bizopsToken: env.BIZOPS_TOKEN,
    resendApiKey: env.RESEND_API_KEY,
    resendApiKeyPersonal: env.RESEND_API_KEY_PERSONAL,
    githubToken: env.GITHUB_TOKEN,
    githubRepo: env.GITHUB_REPO,
    braveApiKey: env.BRAVE_API_KEY,
    notifyEmail: env.AEGIS_NOTIFY_EMAIL,
    baseUrl: env.AEGIS_BASE_URL || operatorConfig.baseUrl,
    ai: env.AI,
    aiGatewayId: gatewayId || undefined,
    anthropicBaseUrl,
    groqBaseUrl,
    ctx,
    roundtableDb: env.ROUNDTABLE_DB,
    cfAnalyticsToken: env.CF_ANALYTICS_TOKEN || undefined,
    imgForgeFetcher: env.IMG_FORGE,
    imgForgeSbSecret: env.IMG_FORGE_SB_SECRET || undefined,
    memoryBinding: env.MEMORY,
    tarotscriptFetcher: env.TAROTSCRIPT,
    maraFetcher: env.MARA,
    maraToken: env.MARA_TOKEN,
    codebeastFetcher: env.CODEBEAST,
    mindspringFetcher: env.MINDSPRING,
    mindspringToken: env.MINDSPRING_TOKEN,
    devtoApiKey: env.DEVTO_API_KEY || undefined,
    gaCredentials: env.GA_CREDENTIALS || undefined,
    blueskyHandle: env.BLUESKY_HANDLE || undefined,
    blueskyAppPassword: env.BLUESKY_APP_PASSWORD || undefined,
  };
}
