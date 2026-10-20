// Local development only: runs a real PostgreSQL on 127.0.0.1:5433 without Docker and makes sure
// the `workforce` (dev) and `workforce_test` (integration tests) databases exist.
// Schema and data come from Prisma: `npm run db:migrate` and `npm run db:seed`.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'pgdata');
const PORT = 5433;
const USER = 'attendance';
const PASSWORD = 'dev-only-password';
const DATABASES = ['workforce', 'workforce_test'];

const firstRun = !existsSync(dataDir);
const server = new EmbeddedPostgres({
  databaseDir: dataDir, user: USER, password: PASSWORD, port: PORT, persistent: true,
  // Force UTF-8: on Windows initdb otherwise inherits the system code page (e.g. WIN1256).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});
if (firstRun) await server.initialise();
await server.start();

const admin = new pg.Client({ host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
await admin.connect();
for (const db of DATABASES) {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (!exists.rowCount) {
    // template0 + explicit encoding, so it is UTF-8 even on clusters created before the flag above.
    await admin.query(`CREATE DATABASE ${db} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    console.log(`created database ${db}`);
  }
}
await admin.end();

console.log(`PostgreSQL running on 127.0.0.1:${PORT} (databases: ${DATABASES.join(', ')})`);
const stop = async () => { await server.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
