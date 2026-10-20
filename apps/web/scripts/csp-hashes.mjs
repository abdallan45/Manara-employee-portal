// Postbuild: writes out/csp-hashes.json = { "script": ["sha256-<base64>", ...] } with the SHA-256 of the
// exact text of every inline <script> (no src) in every exported .html under out/, deduplicated and sorted.
// The API reads this file to send a script-src CSP with these hashes instead of 'unsafe-inline'.
// Usage: node scripts/csp-hashes.mjs [outDir]   (default: <app>/out)
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(appDir, 'out'));

async function* htmlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.html')) yield path;
  }
}

/** Inline scripts: <script ...>text</script> whose start tag has no src attribute. Script text is raw (no entities). */
export function inlineScripts(html) {
  const found = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m; (m = re.exec(html)); ) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue;
    found.push(m[2]);
  }
  return found;
}

export const cspHash = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

async function main() {
  const hashes = new Set();
  let files = 0;
  let scripts = 0;
  for await (const file of htmlFiles(outDir)) {
    files++;
    for (const text of inlineScripts(await readFile(file, 'utf8'))) {
      scripts++;
      hashes.add(cspHash(text));
    }
  }
  if (files === 0) throw new Error(`No .html files under ${outDir} - run the build first.`);
  const script = [...hashes].sort();
  await writeFile(join(outDir, 'csp-hashes.json'), `${JSON.stringify({ script }, null, 2)}\n`);
  console.log(`csp-hashes: ${script.length} unique inline script hashes (${scripts} inline scripts in ${files} HTML files) -> ${join(outDir, 'csp-hashes.json')}`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error(`csp-hashes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
