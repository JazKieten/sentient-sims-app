// Plum's channel inside a Claude Code session (dev only; plan tender-wishing-pebble).
// A stdio MCP server, newline-delimited JSON-RPC by hand (no SDK dependency), loaded with
// --dangerously-load-development-channels server:plum. It bridges the session to the app's
// /plum/cc/* routes (services/plum/ClaudeCodeBrain.ts):
//   app -> SSE `turn`      -> notifications/claude/channel {content, meta: {turn, kind}}
//   app -> SSE `catalogue` -> re-fetch the tools, notifications/tools/list_changed
//   tools/call reply       -> POST /plum/cc/reply
//   tools/call <tool>      -> POST /plum/cc/tool (the app runs it with every guard rail)
// Env (launch.mjs sets both): PLUM_APP_URL, PLUM_TOKEN_FILE. Logs go to stderr.
import fs from 'node:fs';
import http from 'node:http';

const APP_URL = process.env.PLUM_APP_URL || 'http://127.0.0.1:25148';
const TOKEN_FILE = process.env.PLUM_TOKEN_FILE || '';
const PROTOCOL_FALLBACK = '2025-06-18';

const say = (...parts) => process.stderr.write(`[plum-channel] ${parts.join(' ')}\n`);

let token = '';
function readToken() {
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    say(`cannot read the token file ${TOKEN_FILE}: ${error.message}`);
    token = '';
  }
  return token;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
}

async function app(method, route, body) {
  const call = () =>
    fetch(`${APP_URL}${route}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-plum-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(130_000),
    });
  let response = await call();
  if (response.status === 401) {
    // The app may have written a new token since we read it
    readToken();
    response = await call();
  }
  if (!response.ok) {
    throw new Error(`${route} answered ${response.status}`);
  }
  return response;
}

// --- tools ---------------------------------------------------------------------------------

let tools = [];

async function fetchTools() {
  try {
    const response = await app('GET', '/plum/cc/catalogue');
    const body = await response.json();
    tools = Array.isArray(body.tools) ? body.tools : [];
    say(`catalogue: ${tools.length} tools`);
  } catch (error) {
    say(`catalogue unavailable: ${error.message}`);
  }
  return tools;
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name, args) {
  try {
    if (name === 'reply') {
      const response = await app('POST', '/plum/cc/reply', { turn: args?.turn, text: args?.text });
      const body = await response.json();
      return textResult(body.message || (body.ok ? 'sent' : 'not sent'), !body.ok);
    }
    const response = await app('POST', '/plum/cc/tool', { name, args: args ?? {} });
    const outcome = await response.json();
    return textResult(typeof outcome.content === 'string' ? outcome.content : JSON.stringify(outcome), !outcome.ok);
  } catch (error) {
    return textResult(`the Sentient Sims app did not answer (${error.message}); is it running?`, true);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) {
    return;
  }
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
          capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'plum', version: '1.0.0' },
          instructions:
            'The Sentient Sims game talks to you through this channel. Each event starts with ' +
            '"[plum turn ID kind=...]"; answer the player only with the reply tool, passing that ID as turn.',
        },
      });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: await fetchTools() } });
    } else if (method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments) });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        void handle(JSON.parse(line));
      } catch (error) {
        say(`bad message: ${error.message}`);
      }
    }
    newline = buffer.indexOf('\n');
  }
});
// The session is gone: so are we
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

// --- the SSE stream from the app ------------------------------------------------------------

let backoff = 1000;

function onEvent(event, data) {
  if (event === 'turn') {
    let turn;
    try {
      turn = JSON.parse(data);
    } catch {
      return;
    }
    notify('notifications/claude/channel', {
      content: String(turn.content ?? ''),
      meta: { turn: String(turn.turn ?? ''), kind: String(turn.kind ?? '') },
    });
    say(`turn ${turn.turn} kind=${turn.kind} delivered`);
  } else if (event === 'catalogue') {
    void fetchTools().then(() => notify('notifications/tools/list_changed'));
  }
}

function connect() {
  readToken();
  const url = new URL('/plum/cc/events', APP_URL);
  const request = http.get(url, { headers: { 'x-plum-token': token, 'accept': 'text/event-stream' } }, (response) => {
    if (response.statusCode !== 200) {
      say(`events answered ${response.statusCode}`);
      response.resume();
      retry();
      return;
    }
    say('connected to the app');
    backoff = 1000;
    // The catalogue may have changed while we were away
    void fetchTools().then(() => notify('notifications/tools/list_changed'));
    let pending = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      pending += chunk.replace(/\r\n/g, '\n');
      let split = pending.indexOf('\n\n');
      while (split >= 0) {
        const block = pending.slice(0, split);
        pending = pending.slice(split + 2);
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) onEvent(event, data.join('\n'));
        split = pending.indexOf('\n\n');
      }
    });
    response.on('end', () => {
      say('the app closed the stream');
      retry();
    });
    response.on('error', () => retry());
  });
  request.on('error', (error) => {
    say(`app not reachable (${error.code ?? error.message})`);
    retry();
  });
}

let retryTimer;
function retry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 15_000);
}

connect();
