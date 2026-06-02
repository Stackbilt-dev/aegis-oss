// Standalone chat shell for self-sufficient AEGIS deployments.

export function chatPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AEGIS</title>
  <meta name="theme-color" content="#10100d">
  <link rel="manifest" href="/manifest.json">
  <style>
    :root {
      --bg: #10100d;
      --panel: #171813;
      --panel-2: #202217;
      --line: #35382a;
      --text: #f3f0e6;
      --muted: #aaa38f;
      --dim: #76705f;
      --accent: #42d6a4;
      --accent-2: #f5c542;
      --danger: #ff6b6b;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
      color-scheme: dark;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      min-height: 100%;
      background:
        linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px) 0 0 / 56px 56px,
        linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px) 0 0 / 56px 56px,
        var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    body {
      min-height: 100vh;
      overflow: hidden;
    }

    button, input, textarea {
      font: inherit;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
      height: 100vh;
    }

    .rail {
      min-width: 0;
      border-right: 1px solid var(--line);
      background: rgba(16, 16, 13, 0.86);
      backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
    }

    .brand {
      padding: 22px;
      border-bottom: 1px solid var(--line);
    }

    .mark {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin-bottom: 18px;
    }

    .wordmark {
      font-size: 18px;
      letter-spacing: 0.18em;
      font-weight: 800;
    }

    .status {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--danger);
      box-shadow: 0 0 18px rgba(255, 107, 107, 0.7);
    }

    .status.ready {
      background: var(--accent);
      box-shadow: 0 0 18px rgba(66, 214, 164, 0.7);
    }

    .token-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }

    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: #0b0c09;
      color: var(--text);
      outline: none;
    }

    input {
      height: 38px;
      padding: 0 11px;
      border-radius: 6px;
    }

    input:focus, textarea:focus {
      border-color: rgba(66, 214, 164, 0.72);
      box-shadow: 0 0 0 3px rgba(66, 214, 164, 0.12);
    }

    button {
      height: 38px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      cursor: pointer;
      padding: 0 12px;
    }

    button:hover { border-color: rgba(66, 214, 164, 0.5); }
    button:disabled { opacity: 0.55; cursor: wait; }

    .primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #06100c;
      font-weight: 800;
    }

    .conversations {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 10px;
    }

    .conversation {
      width: 100%;
      height: auto;
      min-height: 44px;
      text-align: left;
      display: block;
      margin: 0 0 6px;
      padding: 9px 10px;
      color: var(--muted);
      background: transparent;
    }

    .conversation.active {
      color: var(--text);
      background: rgba(66, 214, 164, 0.08);
      border-color: rgba(66, 214, 164, 0.4);
    }

    .conversation-title {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .conversation-time {
      display: block;
      margin-top: 4px;
      color: var(--dim);
      font-size: 11px;
    }

    .workspace {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      height: 100vh;
    }

    .topbar {
      height: 64px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      background: rgba(23, 24, 19, 0.88);
    }

    .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
    }

    .title strong {
      color: var(--text);
      font-weight: 800;
    }

    .messages {
      min-height: 0;
      overflow: auto;
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .empty {
      margin: auto;
      max-width: 620px;
      color: var(--muted);
      line-height: 1.7;
      border: 1px solid var(--line);
      background: rgba(23, 24, 19, 0.7);
      box-shadow: var(--shadow);
      border-radius: 8px;
      padding: 26px;
    }

    .empty h1 {
      margin: 0 0 12px;
      color: var(--text);
      font-size: 19px;
      line-height: 1.2;
      letter-spacing: 0;
    }

    .message {
      max-width: min(820px, 94%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 13px 15px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: rgba(23, 24, 19, 0.84);
    }

    .message.user {
      align-self: flex-end;
      background: rgba(66, 214, 164, 0.09);
      border-color: rgba(66, 214, 164, 0.32);
    }

    .message.assistant {
      align-self: flex-start;
    }

    .meta {
      margin-top: 9px;
      color: var(--dim);
      font-size: 11px;
    }

    .composer {
      border-top: 1px solid var(--line);
      background: rgba(16, 16, 13, 0.92);
      padding: 16px 20px 20px;
    }

    .composer-inner {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }

    textarea {
      min-height: 52px;
      max-height: 180px;
      resize: vertical;
      border-radius: 8px;
      padding: 13px 14px;
      line-height: 1.45;
    }

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      max-width: min(420px, calc(100vw - 36px));
      background: #1b1214;
      border: 1px solid rgba(255, 107, 107, 0.45);
      color: #ffd4d4;
      border-radius: 8px;
      padding: 12px 14px;
      box-shadow: var(--shadow);
      display: none;
    }

    .toast.show { display: block; }

    @media (max-width: 760px) {
      body { overflow: auto; }
      .shell {
        grid-template-columns: 1fr;
        height: auto;
        min-height: 100vh;
      }
      .rail {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        max-height: 250px;
      }
      .workspace { height: calc(100vh - 250px); min-height: 560px; }
      .topbar { padding: 0 14px; }
      .messages { padding: 16px; }
      .composer { padding: 12px; }
      .composer-inner { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="rail">
      <section class="brand">
        <div class="mark">
          <div class="wordmark">AEGIS</div>
          <div id="statusDot" class="status"></div>
        </div>
        <div class="token-row">
          <input id="tokenInput" type="password" autocomplete="off" placeholder="Access token">
          <button id="saveToken" class="primary" type="button">Set</button>
        </div>
      </section>
      <section class="brand">
        <button id="newChat" type="button" class="primary">New Session</button>
      </section>
      <nav id="conversationList" class="conversations" aria-label="Conversations"></nav>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div class="title"><strong id="conversationTitle">Session</strong> <span id="connectionState">locked</span></div>
        <button id="refreshConversations" type="button">Refresh</button>
      </header>

      <section id="messages" class="messages" aria-live="polite">
        <div class="empty">
          <h1>No messages in this session.</h1>
          <p>Send a prompt to start a dispatch run.</p>
        </div>
      </section>

      <form id="composer" class="composer">
        <div class="composer-inner">
          <textarea id="prompt" placeholder="Message AEGIS" rows="2"></textarea>
          <button id="send" class="primary" type="submit">Send</button>
        </div>
      </form>
    </section>
  </main>

  <div id="toast" class="toast"></div>

  <script>
    const els = {
      tokenInput: document.getElementById('tokenInput'),
      saveToken: document.getElementById('saveToken'),
      statusDot: document.getElementById('statusDot'),
      connectionState: document.getElementById('connectionState'),
      conversationList: document.getElementById('conversationList'),
      conversationTitle: document.getElementById('conversationTitle'),
      refreshConversations: document.getElementById('refreshConversations'),
      newChat: document.getElementById('newChat'),
      messages: document.getElementById('messages'),
      composer: document.getElementById('composer'),
      prompt: document.getElementById('prompt'),
      send: document.getElementById('send'),
      toast: document.getElementById('toast')
    };

    let token = localStorage.getItem('aegis_token') || '';
    let conversationId = localStorage.getItem('aegis_conversation_id') || '';
    let assistantNode = null;

    els.tokenInput.value = token;
    updateAuthState();
    if (token) loadConversations();

    els.saveToken.addEventListener('click', function () {
      token = els.tokenInput.value.trim();
      if (token) {
        localStorage.setItem('aegis_token', token);
      } else {
        localStorage.removeItem('aegis_token');
      }
      updateAuthState();
      loadConversations();
    });

    els.refreshConversations.addEventListener('click', loadConversations);
    els.newChat.addEventListener('click', function () {
      conversationId = crypto.randomUUID();
      localStorage.setItem('aegis_conversation_id', conversationId);
      els.conversationTitle.textContent = 'Session';
      renderMessages([]);
      els.prompt.focus();
    });

    els.composer.addEventListener('submit', function (event) {
      event.preventDefault();
      sendMessage();
    });

    els.prompt.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    function updateAuthState() {
      const ready = Boolean(token);
      els.statusDot.classList.toggle('ready', ready);
      els.connectionState.textContent = ready ? 'ready' : 'locked';
    }

    function headers() {
      return {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json'
      };
    }

    function showError(message) {
      els.toast.textContent = message;
      els.toast.classList.add('show');
      setTimeout(function () { els.toast.classList.remove('show'); }, 4200);
    }

    async function loadConversations() {
      if (!token) {
        els.conversationList.innerHTML = '';
        return;
      }
      try {
        const res = await fetch('/api/conversations', { headers: headers() });
        if (!res.ok) throw new Error('Conversations unavailable');
        const data = await res.json();
        renderConversations(data.conversations || []);
      } catch (err) {
        showError(err.message || 'Unable to load conversations');
      }
    }

    function renderConversations(conversations) {
      els.conversationList.innerHTML = '';
      conversations.forEach(function (conversation) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation' + (conversation.id === conversationId ? ' active' : '');
        button.innerHTML =
          '<span class="conversation-title"></span><span class="conversation-time"></span>';
        button.querySelector('.conversation-title').textContent = conversation.title || 'Untitled';
        button.querySelector('.conversation-time').textContent = (conversation.updated_at || '').slice(0, 16);
        button.addEventListener('click', function () {
          conversationId = conversation.id;
          localStorage.setItem('aegis_conversation_id', conversationId);
          els.conversationTitle.textContent = conversation.title || 'Session';
          loadMessages(conversationId);
          renderConversations(conversations);
        });
        els.conversationList.appendChild(button);
      });
    }

    async function loadMessages(id) {
      try {
        const res = await fetch('/api/conversations/' + encodeURIComponent(id) + '/messages', { headers: headers() });
        if (!res.ok) throw new Error('Messages unavailable');
        const data = await res.json();
        renderMessages(data.messages || []);
      } catch (err) {
        showError(err.message || 'Unable to load messages');
      }
    }

    function renderMessages(messages) {
      els.messages.innerHTML = '';
      if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '<h1>No messages in this session.</h1><p>Send a prompt to start a dispatch run.</p>';
        els.messages.appendChild(empty);
        return;
      }
      messages.forEach(function (message) {
        addMessage(message.role, message.content, message.metadata);
      });
    }

    function addMessage(role, content, metadata) {
      const node = document.createElement('article');
      node.className = 'message ' + role;
      const body = document.createElement('div');
      body.textContent = content || '';
      node.appendChild(body);
      if (metadata && (metadata.executor || metadata.classification)) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = [metadata.classification, metadata.executor, metadata.latencyMs ? metadata.latencyMs + 'ms' : ''].filter(Boolean).join(' / ');
        node.appendChild(meta);
      }
      els.messages.appendChild(node);
      els.messages.scrollTop = els.messages.scrollHeight;
      return body;
    }

    async function sendMessage() {
      const text = els.prompt.value.trim();
      if (!text) return;
      if (!token) {
        showError('Access token required');
        els.tokenInput.focus();
        return;
      }
      if (!conversationId) {
        conversationId = crypto.randomUUID();
        localStorage.setItem('aegis_conversation_id', conversationId);
      }

      els.prompt.value = '';
      els.send.disabled = true;
      if (els.messages.querySelector('.empty')) els.messages.innerHTML = '';
      addMessage('user', text);
      assistantNode = addMessage('assistant', '');

      try {
        const res = await fetch('/api/message/stream', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ text: text, conversationId: conversationId })
        });
        if (!res.ok || !res.body) throw new Error('Dispatch unavailable');
        await readSse(res.body);
        await loadConversations();
      } catch (err) {
        if (assistantNode) assistantNode.textContent = 'Error: ' + (err.message || 'dispatch failed');
        showError(err.message || 'Dispatch failed');
      } finally {
        assistantNode = null;
        els.send.disabled = false;
        els.prompt.focus();
      }
    }

    async function readSse(body) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split('\\n\\n');
        buffer = frames.pop() || '';
        frames.forEach(handleFrame);
      }
      if (buffer.trim()) handleFrame(buffer);
    }

    function handleFrame(frame) {
      const line = frame.split('\\n').find(function (part) { return part.startsWith('data: '); });
      if (!line) return;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload.type === 'delta' && assistantNode) {
          assistantNode.textContent += payload.text;
          els.messages.scrollTop = els.messages.scrollHeight;
        }
        if (payload.type === 'done' && payload.conversationId) {
          conversationId = payload.conversationId;
          localStorage.setItem('aegis_conversation_id', conversationId);
        }
        if (payload.type === 'error') showError(payload.error || 'Stream error');
      } catch {
        showError('Malformed stream event');
      }
    }
  </script>
</body>
</html>`;
}
