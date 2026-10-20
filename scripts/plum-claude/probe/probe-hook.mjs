// Step 0 probe: appends every hook's input JSON to hooks.log next to this file. Always exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(here, 'hooks.log'), `${new Date().toISOString()} ${process.argv[2]} ${input.trim()}\n`);
  process.exit(0);
});
