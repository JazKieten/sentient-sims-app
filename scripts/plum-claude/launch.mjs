// npm run plum:claude -- [--continue] [--model sonnet] [--effort medium] [--claude <path>] [--data <dir>]
//
// Starts the Claude Code session that thinks for Plum (dev only; plan tender-wishing-pebble,
// app side services/plum/ClaudeCodeBrain.ts). The app must be running from source with
// Settings > "Plum's brain" on Claude Code. The session runs on YOUR Claude plan: this script
// never reads or passes a credential, it only starts the claude binary you signed in to.
//
// The session gets: the plum channel (server.mjs) and nothing else (--strict-mcp-config, no
// claude.ai connectors), no built-in tools (--tools ""), only the Plum tools allowed without
// a prompt, hooks to the app (hook.mjs), Plum's persona appended to the system prompt, and
// none of your user settings (--setting-sources project, in an empty folder of its own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const APP_URL = process.env.PLUM_APP_URL || 'http://127.0.0.1:25148';

function fail(message) {
  console.error(`\nplum:claude: ${message}\n`);
  process.exit(1);
}

// 1. The claude binary: --claude / CLAUDE_BIN, the native installer's, PATH, the VS Code extension's
function findClaude() {
  const given = option('--claude') ?? process.env.CLAUDE_BIN;
  if (given) {
    if (!fs.existsSync(given)) fail(`--claude ${given} does not exist`);
    return given;
  }
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const local = path.join(os.homedir(), '.local', 'bin', exe);
  if (fs.existsSync(local)) return local;
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(finder, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((line) => line.trim())
      // shell: false cannot run a .cmd / .ps1 shim
      .filter((line) => line && (process.platform !== 'win32' || line.toLowerCase().endsWith('.exe')));
    if (found[0]) return found[0];
  } catch {
    // not on PATH
  }
  const extensions = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extensions)) {
    const binaries = fs
      .readdirSync(extensions)
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .map((name) => path.join(extensions, name, 'resources', 'native-binary', exe))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (binaries[0]) return binaries[0];
  }
  return fail('no claude binary found. Install Claude Code (native installer) or pass --claude <path>.');
}

// 2. The app's data folder, where it keeps the token (<userData>/plum-claude/token)
function findDataDir() {
  const given = option('--data') ?? process.env.PLUM_CC_DIR;
  if (given) return given;
  const roots =
    process.platform === 'win32'
      ? [process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')]
      : process.platform === 'darwin'
        ? [path.join(os.homedir(), 'Library', 'Application Support')]
        : [process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')];
  // The app run from source is "Electron"; a packaged dev build has its own name
  const names = ['Electron', 'sentient-sims-app', 'Sentient Sims', 'sentient-sims'];
  const candidates = roots
    .flatMap((root) => names.map((name) => path.join(root, name, 'plum-claude')))
    .filter((dir) => fs.existsSync(path.join(dir, 'token')))
    .sort((a, b) => fs.statSync(path.join(b, 'token')).mtimeMs - fs.statSync(path.join(a, 'token')).mtimeMs);
  if (candidates[0]) return candidates[0];
  return fail(
    'no token from the app. Start the companion app from source (npm run start) first; it writes ' +
      '<its data folder>/plum-claude/token. Or pass --data <that plum-claude folder>.',
  );
}

const claude = findClaude();
const dataDir = findDataDir();
const tokenFile = path.join(dataDir, 'token');
const token = fs.readFileSync(tokenFile, 'utf8').trim();

// 3. The app answers, and is a build with the brain
let persona;
try {
  const response = await fetch(`${APP_URL}/plum/cc/persona`, {
    headers: { 'x-plum-token': token },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) fail(`the app refused the token in ${tokenFile}; restart the app and try again.`);
  if (response.status === 404)
    fail('this app build has no Claude Code brain (it needs the dev tier, run from source).');
  if (!response.ok) fail(`the app answered ${response.status}.`);
  persona = await response.text();
} catch (error) {
  fail(`the companion app is not answering at ${APP_URL} (${error.cause?.code ?? error.message}). Start it first.`);
}
try {
  const response = await fetch(`${APP_URL}/settings/app/plumBrain`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  if (body?.value !== 'claude-code') {
    console.warn(
      "plum:claude: note: Settings > Plum's brain is not on Claude Code yet; the tab keeps using the API until it is.",
    );
  }
} catch {
  // informational only
}

// 4. The session's files, in a folder of its own (--continue picks up the last session there)
const sessionDir = path.join(dataDir, 'session');
fs.mkdirSync(sessionDir, { recursive: true });
const slash = (file) => file.replace(/\\/g, '/');
const node = process.execPath;
const env = { PLUM_APP_URL: APP_URL, PLUM_TOKEN_FILE: tokenFile };
const mcpFile = path.join(dataDir, 'plum-mcp.json');
fs.writeFileSync(
  mcpFile,
  JSON.stringify(
    { mcpServers: { plum: { command: node, args: [path.join(here, 'server.mjs')], env, alwaysLoad: true } } },
    null,
    2,
  ),
);
const hook = (event) => [
  {
    hooks: [
      { type: 'command', command: `"${slash(node)}" "${slash(path.join(here, 'hook.mjs'))}" ${event}`, timeout: 5 },
    ],
  },
];
const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact'];
const settingsFile = path.join(dataDir, 'plum-settings.json');
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      permissions: { allow: ['mcp__plum__*'] },
      disableClaudeAiConnectors: true,
      hooks: Object.fromEntries(events.map((event) => [event, hook(event)])),
    },
    null,
    2,
  ),
);
const personaFile = path.join(dataDir, 'persona.md');
fs.writeFileSync(personaFile, persona);

// 5. Start it on the developer's own sign-in
const childEnv = {
  ...process.env,
  ...env,
  MCP_PROTOCOL_NEGOTIATION: 'legacy',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
if (childEnv.ANTHROPIC_API_KEY) {
  console.warn('plum:claude: ANTHROPIC_API_KEY is set in this shell; not passing it on (the session uses your plan).');
  delete childEnv.ANTHROPIC_API_KEY;
}
for (const name of [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
]) {
  if (childEnv[name]) {
    console.warn(`plum:claude: warning: ${name} is set; the session may not run on your Claude plan.`);
  }
}
const args = [
  '--strict-mcp-config',
  '--mcp-config',
  mcpFile,
  '--settings',
  settingsFile,
  '--setting-sources',
  'project',
  '--tools',
  '',
  '--allowedTools',
  'mcp__plum__*',
  '--append-system-prompt-file',
  personaFile,
  '--model',
  option('--model') ?? 'opus',
  '--effort',
  option('--effort') ?? 'medium',
  '--system-prompt-snapshot',
  'off',
  '--name',
  'Plum',
  '--dangerously-load-development-channels',
  'server:plum',
  ...(argv.includes('--continue') ? ['--continue'] : []),
];
console.log(`plum:claude: ${claude}`);
console.log(`plum:claude: session folder ${sessionDir}`);
console.log('plum:claude: keep this terminal OFF the stream capture; switch Plum back to API in Settings any time.\n');
const child = spawn(claude, args, { cwd: sessionDir, env: childEnv, stdio: 'inherit', shell: false });
child.on('error', (error) => fail(`could not start ${claude}: ${error.message}`));
child.on('exit', (code) => process.exit(code ?? 0));
