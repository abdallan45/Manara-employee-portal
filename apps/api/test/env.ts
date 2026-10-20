// Loaded before every test file: point Prisma at the isolated test database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// TEST_ENV_FILE lets parallel workers point at separate test databases (default: .env.test).
for (const line of readFileSync(join(__dirname, '..', process.env.TEST_ENV_FILE || '.env.test'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.DEMO_MODE = 'false';
process.env.NODE_ENV = 'test';
