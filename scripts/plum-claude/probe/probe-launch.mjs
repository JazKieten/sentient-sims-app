// Step 0 probe launcher: node scripts/plum-claude/probe/probe-launch.mjs [--claude <path>] [--loose]
// Starts an interactive claude.exe with the probe channel as `plum`, hooks logging to
// hooks.log, no built-in tools and no claude.ai connectors. --loose drops
// --strict-mcp-config and --setting-sources (the fallback layout).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

function findClaude() {
  const given = flag('--claude') ?? process.env.CLAUDE_BIN;
  if (given) return given;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  const found = fs
    .readdirSync(extensions)
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .map((name) => path.join(extensions, name, 'resources', 'native-binary', 'claude.exe'))
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (found[0]) return found[0];
  throw new Error('no claude.exe found; pass --claude <path>');
}

const work = path.join(here, 'work');
fs.mkdirSync(work, { recursive: true });
const slash = (file) => file.replace(/\\/g, '/');
const hook = (event) => ({
  hooks: [
    { type: 'command', command: `"${slash(process.execPath)}" "${slash(path.join(here, 'probe-hook.mjs'))}" ${event}` },
  ],
});
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact'];
fs.writeFileSync(
  path.join(work, 'probe-mcp.json'),
  JSON.stringify(
    {
      mcpServers: {
        plum: { command: process.execPath, args: [path.join(here, 'probe-server.mjs')], alwaysLoad: true },
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(work, 'probe-settings.json'),
  JSON.stringify(
    {
      permissions: { allow: ['mcp__plum__*'] },
      disableClaudeAiConnectors: true,
      hooks: Object.fromEntries(events.map((event) => [event, [hook(event)]])),
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(work, 'persona.md'),
  'PROBE PERSONA: you are Plum-probe. When asked who you are, say "I am Plum-probe".\n',
);

const loose = argv.includes('--loose');
const args = [
  ...(loose ? [] : ['--strict-mcp-config', '--setting-sources', 'project']),
  '--mcp-config',
  path.join(work, 'probe-mcp.json'),
  '--settings',
  path.join(work, 'probe-settings.json'),
  '--tools',
  '',
  '--allowedTools',
  'mcp__plum__*',
  '--append-system-prompt-file',
  path.join(work, 'persona.md'),
  '--model',
  flag('--model') ?? 'sonnet',
  '--effort',
  'low',
  '--dangerously-load-development-channels',
  'server:plum',
];
// --print "<prompt>": a non-interactive smoke run (channels are ignored with -p; the tools,
// hooks and persona are not)
const printPrompt = flag('--print');
if (printPrompt) {
  args.push('-p', printPrompt);
}
const env = { ...process.env, MCP_PROTOCOL_NEGOTIATION: 'legacy', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
delete env.ANTHROPIC_API_KEY;
const claude = findClaude();
console.log(`probe: ${claude}\n  ${args.join(' ')}`);
const child = spawn(claude, args, {
  cwd: work,
  env,
  stdio: printPrompt ? ['ignore', 'inherit', 'inherit'] : 'inherit',
  shell: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
