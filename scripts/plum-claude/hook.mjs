// A Claude Code hook for Plum's session: posts the hook's input JSON to the app's
// /plum/cc/hook (services/plum/ClaudeCodeBrain.ts) with a 2 s timeout, and ALWAYS exits 0
// so a closed app never blocks the session. Usage (launch.mjs writes it): node hook.mjs <Event>
import fs from 'node:fs';

const APP_URL = process.env.PLUM_APP_URL || 'http://127.0.0.1:25148';
const TOKEN_FILE = process.env.PLUM_TOKEN_FILE || '';

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
});
process.stdin.on('end', async () => {
  try {
    const body = JSON.parse(input || '{}');
    if (!body.hook_event_name && process.argv[2]) {
      body.hook_event_name = process.argv[2];
    }
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    await fetch(`${APP_URL}/plum/cc/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plum-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // The app is down or slow: the session carries on
  }
  process.exit(0);
});
