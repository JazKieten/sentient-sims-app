// Step 0 probe (plan tender-wishing-pebble): a stub channel server for one live session.
// stdio MCP (newline-delimited JSON-RPC) with an echo tool and a reply tool; a localhost
// HTTP trigger pushes a channel event: GET http://127.0.0.1:25290/push?text=hi&turn=p1
// Every message in or out is appended to probe.log next to this file.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(here, 'probe.log');
const note = (what, data) =>
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${what} ${JSON.stringify(data)}\n`);

const send = (message) => {
  note('out', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'reply',
    description: 'Reply to the player of turn `turn`.',
    inputSchema: {
      type: 'object',
      properties: { turn: { type: 'string' }, text: { type: 'string' } },
      required: ['turn', 'text'],
    },
  },
];

function handle(message) {
  note('in', message);
  const { id, method, params } = message;
  if (id === undefined) {
    return;
  }
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'plum-probe', version: '0.0.1' },
        instructions: 'Messages arrive as <channel source="plum"> starting [plum turn ID]. Answer with the reply tool.',
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const text = `${params?.name}: ${JSON.stringify(params?.arguments ?? {})}`;
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });
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
        handle(JSON.parse(line));
      } catch (error) {
        note('bad', { line, error: String(error) });
      }
    }
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/push') {
      const turn = url.searchParams.get('turn') ?? 'p1';
      const text = url.searchParams.get('text') ?? 'say hi with the reply tool';
      send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: { content: `[plum turn ${turn} kind=chat]\n${text}`, meta: { turn, kind: 'chat' } },
      });
    }
    res.end('ok\n');
  })
  .listen(25290, '127.0.0.1');
note('start', { pid: process.pid });
