// MindSpring v2 write pipeline — push extracted facts to topic notebooks

import type { EdgeEnv } from '../dispatch.js';

const WORKSPACE_ID = 'aegis-daemon';
const MS_BASE = 'https://mindspring';

interface MsNotebook { id: string; title: string }
interface UploadAccepted { uploadId: string; status: string }

export interface FactEntry {
  topic: string;
  fact: string;
  confidence: number;
}

function msHeaders(token: string, extra?: Record<string, string>): Headers {
  const h = new Headers(extra);
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function findOrCreateNotebook(topic: string, env: EdgeEnv): Promise<string> {
  const token = env.mindspringIngestToken!;
  const fetcher = env.mindspringFetcher!;

  const listResp = await fetcher.fetch(
    `${MS_BASE}/api/v2/workspaces/${WORKSPACE_ID}/notebooks`,
    { headers: msHeaders(token) },
  );
  if (listResp.ok) {
    const data = await listResp.json<{ notebooks: MsNotebook[] }>();
    const existing = data.notebooks?.find((nb) => nb.title === topic);
    if (existing) return existing.id;
  }

  const createResp = await fetcher.fetch(
    `${MS_BASE}/api/v2/workspaces/${WORKSPACE_ID}/notebooks`,
    {
      method: 'POST',
      headers: msHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title: topic, type: 'research' }),
    },
  );
  if (!createResp.ok) {
    const msg = await createResp.text().catch(() => '');
    throw new Error(`create notebook failed: ${createResp.status} ${msg.slice(0, 120)}`);
  }
  const nb = await createResp.json<MsNotebook>();
  return nb.id;
}

async function uploadContent(content: string, filename: string, env: EdgeEnv): Promise<string> {
  const token = env.mindspringIngestToken!;
  const fetcher = env.mindspringFetcher!;

  const resp = await fetcher.fetch(`${MS_BASE}/api/uploads/simple`, {
    method: 'POST',
    headers: msHeaders(token, {
      'Content-Type': 'text/plain',
      'X-File-Name': filename,
    }),
    body: content,
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`upload failed: ${resp.status} ${msg.slice(0, 120)}`);
  }
  const { uploadId } = await resp.json<UploadAccepted>();
  return uploadId;
}

async function registerSource(notebookId: string, title: string, uploadId: string, env: EdgeEnv): Promise<void> {
  const token = env.mindspringIngestToken!;
  const fetcher = env.mindspringFetcher!;

  const resp = await fetcher.fetch(
    `${MS_BASE}/api/v2/workspaces/${WORKSPACE_ID}/notebooks/${notebookId}/sources`,
    {
      method: 'POST',
      headers: msHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ title, type: 'txt', sourceUploadId: uploadId, parserType: 'txt' }),
    },
  );
  if (!resp.ok && resp.status !== 202) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`register source failed: ${resp.status} ${msg.slice(0, 120)}`);
  }
}

/**
 * Push extracted facts to MindSpring v2 topic notebooks.
 * Groups facts by topic, creates notebooks as needed.
 * Never throws — all errors are logged as warnings.
 */
export async function pushFactsToMindSpring(
  facts: FactEntry[],
  sourceTag: string,
  env: EdgeEnv,
): Promise<void> {
  if (!env.mindspringFetcher || !env.mindspringIngestToken || facts.length === 0) return;

  // Group by topic
  const byTopic = new Map<string, string[]>();
  for (const { topic, fact } of facts) {
    const arr = byTopic.get(topic) ?? [];
    arr.push(fact);
    byTopic.set(topic, arr);
  }

  const date = new Date().toISOString().slice(0, 10);

  for (const [topic, topicFacts] of byTopic.entries()) {
    try {
      const content = [
        `Topic: ${topic}`,
        `Source: ${sourceTag}`,
        `Date: ${date}`,
        '',
        ...topicFacts.map((f) => `- ${f}`),
      ].join('\n');

      const notebookId = await findOrCreateNotebook(topic, env);
      const uploadId = await uploadContent(content, `${topic}-facts.txt`, env);
      await registerSource(notebookId, `facts-${date}-${sourceTag.slice(0, 12)}`, uploadId, env);

      console.log(`[mindspring-nb] pushed ${topicFacts.length} fact(s) → notebook '${topic}' (${notebookId.slice(0, 8)})`);
    } catch (err) {
      console.warn(`[mindspring-nb] topic '${topic}' push failed:`, err instanceof Error ? err.message : String(err));
    }
  }
}
