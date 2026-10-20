// Local development only: loads dev/.env.dev and runs the built API (api/dist/main.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(here, '.env.dev'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
await import(pathToFileURL(path.join(here, '..', 'api', 'dist', 'main.js')).href);
