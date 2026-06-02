import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useVoiceAgent } from '@cloudflare/voice/react';
import './styles.css';

type Conversation = {
  id: string;
  title: string | null;
  created_at?: string;
  updated_at?: string;
};

type Message = {
  id: string;
  role: 'user' | 'assistant' | string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

type HealthPayload = {
  status: string;
  version: string;
  mode: string;
  kernel?: Record<string, number>;
  tasks_24h?: Array<{ task_name: string; runs: number; ok: number; errors: number }>;
  docs_sync_status?: { status: string; lastSyncAge: number | null };
};

const TOKEN_KEY = 'aegis_token';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '');
  const [tokenDraft, setTokenDraft] = useState(token);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('Ready');
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [voiceText, setVoiceText] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const voice = useVoiceAgent({
    agent: 'AegisVoiceAdapter',
    name: 'operator',
    query: token ? { token } : undefined,
  });

  const authHeaders = useMemo<Record<string, string>>(
    () => {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return headers;
    },
    [token],
  );

  useEffect(() => {
    document.cookie = token
      ? `aegis_token=${encodeURIComponent(token)};path=/;max-age=31536000;SameSite=Strict;Secure`
      : 'aegis_token=;path=/;max-age=0;SameSite=Strict;Secure';
  }, [token]);

  useEffect(() => {
    void refreshHealth();
    if (token) void refreshConversations();
  }, [token]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages]);

  async function refreshHealth() {
    const res = await fetch('/health?format=json', {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      setHealth(await res.json());
    }
  }

  async function refreshConversations() {
    const res = await fetch('/api/conversations', { headers: authHeaders });
    if (!res.ok) {
      setStatus(res.status === 401 ? 'Add your AEGIS token' : `Conversations failed: ${res.status}`);
      return;
    }
    const data = await res.json() as { conversations: Conversation[] };
    setConversations(data.conversations);
  }

  async function loadConversation(id: string) {
    setConversationId(id);
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      headers: authHeaders,
    });
    if (!res.ok) {
      setStatus(`History failed: ${res.status}`);
      return;
    }
    const data = await res.json() as { messages: Message[] };
    setMessages(data.messages);
  }

  function saveToken() {
    const next = tokenDraft.trim();
    localStorage.setItem(TOKEN_KEY, next);
    setToken(next);
    setStatus(next ? 'Token saved' : 'Token cleared');
  }

  async function sendMessage(text = prompt.trim()) {
    if (!text) return;
    if (!token) {
      setStatus('Add your AEGIS token');
      return;
    }

    const optimisticUser: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      optimisticUser,
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPrompt('');
    setStatus('Streaming');

    const res = await fetch('/api/message/stream', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, conversationId, executor: 'workers_ai' }),
    });

    if (!res.ok || !res.body) {
      setStatus(`Message failed: ${res.status}`);
      return;
    }

    let assistantText = '';
    for await (const frame of readSse(res.body)) {
      if (frame.type === 'start' && typeof frame.conversationId === 'string') {
        setConversationId(frame.conversationId);
      }
      if (frame.type === 'delta' && typeof frame.text === 'string') {
        assistantText += frame.text;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content: assistantText } : message
        )));
      }
      if (frame.type === 'error') {
        setStatus(typeof frame.error === 'string' ? frame.error : 'Stream error');
      }
      if (frame.type === 'done') {
        setStatus('Ready');
        void refreshConversations();
      }
    }
  }

  function sendVoiceText() {
    const text = voiceText.trim();
    if (!text) return;
    voice.sendText(text);
    setVoiceText('');
  }

  const activeConversation = conversations.find((conversation) => conversation.id === conversationId);
  const taskErrors = health?.tasks_24h?.reduce((sum, task) => sum + Number(task.errors ?? 0), 0) ?? 0;

  return (
    <main className="shell">
      <aside className="rail" aria-label="AEGIS navigation">
        <section className="brand">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div>
            <h1>AEGIS</h1>
            <p>Edge-native operator console</p>
          </div>
        </section>

        <section className="token-panel" aria-label="Access token">
          <label htmlFor="token">Access token</label>
          <div className="token-row">
            <input
              id="token"
              type="password"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              autoComplete="off"
            />
            <button type="button" onClick={saveToken} aria-label="Save token">OK</button>
          </div>
        </section>

        <section className="health-panel" aria-label="Health dashboard">
          <div className="panel-title">
            <span>Health</span>
            <button type="button" onClick={refreshHealth} aria-label="Refresh health">R</button>
          </div>
          <dl className="health-grid">
            <div>
              <dt>Status</dt>
              <dd>{health?.status ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{health?.version ?? '-'}</dd>
            </div>
            <div>
              <dt>Kernel</dt>
              <dd>{health?.kernel ? Object.values(health.kernel).reduce((a, b) => a + b, 0) : '-'}</dd>
            </div>
            <div>
              <dt>Task errors</dt>
              <dd>{taskErrors}</dd>
            </div>
          </dl>
        </section>

        <section className="conversation-panel" aria-label="Conversations">
          <div className="panel-title">
            <span>Conversations</span>
            <button type="button" onClick={refreshConversations} aria-label="Refresh conversations">R</button>
          </div>
          <button
            type="button"
            className="new-chat"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
            }}
          >
            New session
          </button>
          <div className="conversation-list">
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={conversation.id === conversationId ? 'conversation active' : 'conversation'}
                onClick={() => loadConversation(conversation.id)}
              >
                <span>{conversation.title || 'Untitled'}</span>
                <small>{conversation.updated_at ? new Date(conversation.updated_at).toLocaleString() : 'recent'}</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Self-sufficient deploy</p>
            <h2>{activeConversation?.title || 'Operator session'}</h2>
          </div>
          <div className="runtime-status" aria-live="polite">
            <span className={token ? 'dot online' : 'dot'} aria-hidden="true" />
            {status}
          </div>
        </header>

        <section className="message-surface" ref={messagesRef} aria-label="Messages">
          {messages.length === 0 ? (
            <div className="empty-state">
              <p>Ask the agent to inspect memory, explain its health, or plan the next deployment step.</p>
            </div>
          ) : messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-role">{message.role}</div>
              <div className="message-content">{message.content || '...'}</div>
            </article>
          ))}
        </section>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Message AEGIS"
            rows={3}
          />
          <button type="submit" aria-label="Send message">Send</button>
        </form>
      </section>

      <aside className="voice-panel" aria-label="Voice call">
        <div className="panel-title">
          <span>Voice</span>
          <span className="voice-state">{voice.status}</span>
        </div>
        <div className="meter" aria-label="Audio level">
          <span style={{ width: `${Math.round(voice.audioLevel * 100)}%` }} />
        </div>
        <div className="voice-actions">
          <button type="button" onClick={() => voice.connected ? voice.endCall() : void voice.startCall()}>
            {voice.connected ? 'End call' : 'Start call'}
          </button>
          <button type="button" onClick={voice.toggleMute} disabled={!voice.connected}>
            {voice.isMuted ? 'Unmute' : 'Mute'}
          </button>
        </div>
        {voice.error ? <p className="error">{voice.error}</p> : null}
        <div className="voice-transcript">
          {voice.transcript.slice(-8).map((entry, index) => (
            <p key={`${entry.role}-${index}`}>
              <strong>{entry.role}</strong>
              <span>{entry.text}</span>
            </p>
          ))}
          {voice.interimTranscript ? <p><strong>interim</strong><span>{voice.interimTranscript}</span></p> : null}
        </div>
        <div className="voice-text">
          <input
            value={voiceText}
            onChange={(event) => setVoiceText(event.target.value)}
            placeholder="Send text to voice agent"
          />
          <button type="button" onClick={sendVoiceText} disabled={!voice.connected}>Send</button>
        </div>
      </aside>
    </main>
  );
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      yield JSON.parse(dataLine.slice(6));
    }
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
