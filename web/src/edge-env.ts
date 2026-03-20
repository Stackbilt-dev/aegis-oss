// Edge environment builder — maps Cloudflare Worker Env bindings to kernel EdgeEnv
import type { EdgeEnv } from './kernel/dispatch.js';
import type { Env } from './types.js';

export function buildEdgeEnv(env: Env, ctx?: ExecutionContext): EdgeEnv {
  const aiGatewayId = env.AI_GATEWAY_ID || undefined;
  const anthropicBase = aiGatewayId
    ? `https://gateway.ai.cloudflare.com/v1/5bea0dafb9c8274290fe2fbe8487fadf/${aiGatewayId}/anthropic`
    : 'https://api.anthropic.com';
  const groqBase = aiGatewayId
    ? `https://gateway.ai.cloudflare.com/v1/5bea0dafb9c8274290fe2fbe8487fadf/${aiGatewayId}/groq`
    : 'https://api.groq.com/openai';

  return {
    db: env.DB,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    opusModel: env.CLAUDE_OPUS_MODEL || 'claude-opus-4-20250514',
    gptOssModel: env.GPT_OSS_MODEL || 'claude-sonnet-4-20250514',
    groqApiKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    groqResponseModel: env.GROQ_RESPONSE_MODEL || 'llama-3.3-70b-versatile',
    groqGptOssModel: env.GROQ_GPT_OSS_MODEL || 'llama-3.3-70b-versatile',
    bizopsFetcher: env.BIZOPS,
    bizopsToken: env.BIZOPS_TOKEN,
    resendApiKey: env.RESEND_API_KEY,
    resendApiKeyPersonal: env.RESEND_API_KEY_PERSONAL,
    githubToken: env.GITHUB_TOKEN,
    githubRepo: env.GITHUB_REPO,
    braveApiKey: env.BRAVE_API_KEY,
    notifyEmail: env.AEGIS_NOTIFY_EMAIL,
    baseUrl: env.AEGIS_BASE_URL,
    ai: env.AI,
    aiGatewayId,
    anthropicBaseUrl: anthropicBase,
    groqBaseUrl: groqBase,
    ctx,
    roundtableDb: env.ROUNDTABLE_DB,
    cfAnalyticsToken: env.CF_ANALYTICS_TOKEN,
    imgForgeFetcher: env.IMG_FORGE,
    imgForgeSbSecret: env.IMG_FORGE_SB_SECRET,
    memoryBinding: env.MEMORY,
    tarotscriptFetcher: env.TAROTSCRIPT,
    maraFetcher: env.MARA,
    maraToken: env.MARA_TOKEN,
    codebeastFetcher: env.CODEBEAST,
    mindspringFetcher: env.MINDSPRING,
    mindspringToken: env.MINDSPRING_TOKEN,
    devtoApiKey: env.DEVTO_API_KEY,
  };
}
