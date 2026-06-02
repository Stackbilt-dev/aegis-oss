#!/usr/bin/env node
// AEGIS CLI: zero-dependency terminal chat over /chat/ws.
// Requires Node >= 21 for the built-in WebSocket client.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const HELP = `AEGIS CLI

Usage:
  aegis [--host <host>] [--token <token>] [--exec <executor>] [--conversation <uuid>] [--verbose] [--quick]

Options:
  --host <host>            AEGIS worker host or URL. Defaults to AEGIS_HOST or aegis.stackbilt.dev.
  --token <token>          Bearer token. Defaults to AEGIS_TOKEN.
  --exec <executor>        Force an executor for this session. Use auto to let the kernel route.
  --conversation <uuid>    Resume an existing conversation.
  --verbose                Show executor/classification/cost metadata after each response.
  --quick                  Skip the startup executor picker.
  --version                Print version and exit.
  --help                   Print this help and exit.

REPL commands:
  /new  /exec [name]  /verbose  /clear  /help  /quit
`;

if (has('--help') || has('-h')) {
  console.log(HELP.trimEnd());
  process.exit(0);
}
if (has('--version') || has('-v')) {
  console.log(pkg.version);
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.error('AEGIS CLI requires Node >= 21 for built-in WebSocket support.');
  process.exit(1);
}

let conversationId = argVal('--conversation') || null;
let executor = normalizeExecutor(argVal('--exec'));
let verbose = has('--verbose');
const quick = has('--quick') || Boolean(argVal('--exec'));
const token = argVal('--token') || process.env.AEGIS_TOKEN;
const host = normalizeHost(argVal('--host') || process.env.AEGIS_HOST || 'aegis.stackbilt.dev');

if (!token) {
  console.error('Missing AEGIS_TOKEN. Set AEGIS_TOKEN or pass --token <token>.');
  process.exit(1);
}

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const paint = (color, s) => `${color}${s}${c.reset}`;

const EXECUTORS = [
  { value: null, label: 'auto', hint: 'kernel routes automatically' },
  { value: 'workers_ai', label: 'workers_ai', hint: 'Cloudflare Workers AI' },
  { value: 'gpt_oss', label: 'gpt_oss', hint: 'tool-capable standard path' },
  { value: 'groq', label: 'groq', hint: 'fast simple responses' },
  { value: 'claude', label: 'claude', hint: 'reliability-critical work' },
  { value: 'claude_opus', label: 'claude_opus', hint: 'frontier tier' },
  { value: 'composite', label: 'composite', hint: 'multi-model synthesis' },
];

const EXECUTOR_VALUES = new Set(EXECUTORS.map((e) => e.value).filter(Boolean));

function normalizeExecutor(value) {
  if (!value || value === 'auto') return null;
  return value;
}

function normalizeHost(value) {
  return value.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').replace(/\/+$/, '');
}

function printBanner() {
  console.log('');
  console.log(paint(c.cyan, 'AEGIS'));
  console.log(paint(c.dim, 'persistent agent terminal'));
  console.log('');
}

function select(title, options, initial = 0) {
  return new Promise((resolve) => {
    let idx = initial;
    readline.emitKeypressEvents(stdin);
    const wasRaw = Boolean(stdin.isRaw);
    if (stdin.isTTY) stdin.setRawMode(true);

    const draw = (first = false) => {
      if (!first) stdout.write(`\x1b[${options.length + 1}A`);
      stdout.write(`${c.bold}?${c.reset} ${title}\x1b[K\n`);
      options.forEach((o, i) => {
        const on = i === idx;
        const pointer = on ? paint(c.cyan, '>') : ' ';
        const label = on ? paint(c.cyan, o.label) : o.label;
        const hint = o.hint ? paint(c.dim, `  - ${o.hint}`) : '';
        stdout.write(`${pointer} ${label}${hint}\x1b[K\n`);
      });
    };

    const done = (value) => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      resolve(value);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        idx = (idx - 1 + options.length) % options.length;
        draw();
      } else if (key.name === 'down' || key.name === 'j') {
        idx = (idx + 1) % options.length;
        draw();
      } else if (key.name === 'return') {
        done(options[idx].value);
      } else if (key.name === 'escape') {
        done(options[initial].value);
      } else if (key.ctrl && key.name === 'c') {
        stdout.write('\n');
        process.exit(0);
      }
    };

    draw(true);
    stdin.on('keypress', onKey);
  });
}

function makeSpinner(label) {
  const frames = ['-', '\\', '|', '/'];
  let i = 0;
  let timer = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        stdout.write(`\r${paint(c.cyan, frames[i = (i + 1) % frames.length])} ${paint(c.dim, label)}\x1b[K`);
      }, 90);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      stdout.write('\r\x1b[K');
    },
  };
}

const fmtCost = (n) => (typeof n === 'number' ? `$${n.toFixed(5)}` : `$${n ?? 0}`);
const think = makeSpinner('thinking');
let rl = null;
let conn = null;

function connect() {
  const q = new URLSearchParams({ token });
  if (conversationId) q.set('conversationId', conversationId);
  const ws = new WebSocket(`wss://${host}/chat/ws?${q.toString()}`, 'aegis-chat');
  let streaming = false;
  let pending = false;
  let firstDelta = false;

  ws.addEventListener('open', () => {
    think.stop();
    console.log(`${paint(c.green, 'connected')} ${paint(c.dim, host)}`);
    console.log(`${paint(c.dim, 'executor')} ${executor || 'auto'}`);
    console.log(`${paint(c.dim, 'conversation')} ${conversationId ?? 'new on first message'}`);
    console.log(paint(c.dim, '/new  /exec [name]  /verbose  /clear  /help  /quit'));
    startRepl();
  });

  ws.addEventListener('message', (ev) => {
    let frame;
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    } catch {
      return;
    }

    switch (frame.type) {
      case 'history':
        if (Array.isArray(frame.messages) && frame.messages.length) {
          console.log(paint(c.dim, `${frame.messages.length} prior messages loaded`));
        }
        break;
      case 'start':
        if (frame.conversationId) conversationId = frame.conversationId;
        streaming = true;
        firstDelta = false;
        break;
      case 'delta':
        if (!frame.text) break;
        if (!firstDelta) {
          think.stop();
          stdout.write(`${paint(c.cyan, 'aegis')} `);
          firstDelta = true;
        }
        stdout.write(frame.text);
        break;
      case 'done':
        if (!firstDelta) think.stop();
        streaming = false;
        pending = false;
        stdout.write('\n');
        if (verbose && frame.metadata) {
          const md = frame.metadata;
          console.log(paint(c.dim, `${md.executor} / ${md.classification} / ${fmtCost(md.cost)} / ${md.latencyMs ?? '?'}ms${md.grounded !== undefined ? ` / grounded=${md.grounded}` : ''}`));
          if (md.unverifiedClaims?.length) console.log(paint(c.yellow, `${md.unverifiedClaims.length} unverified claim(s)`));
        }
        rl?.prompt();
        break;
      case 'error':
        think.stop();
        streaming = false;
        pending = false;
        console.log(`\n${paint(c.red, 'error:')} ${frame.error}`);
        rl?.prompt();
        break;
    }
  });

  ws.addEventListener('error', () => {
    think.stop();
    console.log(paint(c.red, 'websocket error'));
  });
  ws.addEventListener('close', (ev) => {
    think.stop();
    console.log(paint(c.dim, `disconnected${ev.reason ? ` (${ev.reason})` : ''}`));
    process.exit(ev.code === 1000 ? 0 : 1);
  });

  return {
    send(text) {
      if (pending || streaming) {
        console.log(paint(c.dim, 'still responding'));
        return;
      }
      pending = true;
      think.start();
      ws.send(JSON.stringify({
        type: 'message',
        text,
        conversationId,
        eventId: crypto.randomUUID(),
        ...(executor ? { executor } : {}),
      }));
    },
    close() {
      ws.close(1000, 'bye');
    },
  };
}

function startRepl() {
  rl = readline.createInterface({ input: stdin, output: stdout, prompt: `${paint(c.green, '>')} ` });
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    if (text.startsWith('/')) {
      const [cmd, arg] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'new':
          conversationId = null;
          console.log(paint(c.dim, 'new conversation on next message'));
          break;
        case 'exec':
          if (arg) {
            const next = normalizeExecutor(arg);
            if (next && !EXECUTOR_VALUES.has(next)) {
              console.log(paint(c.dim, `unknown executor: ${arg}`));
            } else {
              executor = next;
              console.log(paint(c.dim, `executor -> ${executor || 'auto'}`));
            }
            break;
          }
          if (!stdin.isTTY) {
            console.log(paint(c.dim, `usage: /exec <${EXECUTORS.map((e) => e.label).join('|')}>`));
            break;
          }
          rl.removeAllListeners('line');
          rl.close();
          executor = await select('executor', EXECUTORS, Math.max(0, EXECUTORS.findIndex((e) => e.value === executor)));
          console.log(paint(c.dim, `executor -> ${executor || 'auto'}`));
          startRepl();
          return;
        case 'verbose':
          verbose = !verbose;
          console.log(paint(c.dim, `verbose ${verbose ? 'on' : 'off'}`));
          break;
        case 'clear':
          stdout.write('\x1b[2J\x1b[H');
          break;
        case 'help':
          console.log(paint(c.dim, '/new  /exec [name]  /verbose  /clear  /help  /quit'));
          break;
        case 'quit':
        case 'q':
        case 'exit':
          conn.close();
          return;
        default:
          console.log(paint(c.dim, `unknown command /${cmd}`));
      }
      rl.prompt();
      return;
    }

    conn.send(text);
  });

  rl.on('SIGINT', () => conn.close());
}

async function main() {
  if (executor && !EXECUTOR_VALUES.has(executor)) {
    console.error(`Unknown executor: ${executor}`);
    process.exit(1);
  }
  printBanner();
  if (!executor && !quick && stdin.isTTY) {
    executor = await select('Launch executor', EXECUTORS, 0);
  }
  think.start();
  conn = connect();
}

main().catch((err) => {
  console.error(`aegis: ${err.message}`);
  process.exit(1);
});
