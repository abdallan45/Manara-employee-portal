import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ensureRbac } from '../prisma/rbac';

export const prisma = new PrismaClient();

/** Statement-level triggers that block TRUNCATE on the append-only tables (migration audit_hardening). */
const TRUNCATE_GUARDS = [
  { table: 'audit_logs', trigger: 'audit_logs_no_truncate' },
  { table: 'attendance_events', trigger: 'attendance_events_no_truncate' },
];

/**
 * Wipes all application tables and re-seeds roles. Test-only: TRUNCATE skips the append-only row
 * triggers, and the TRUNCATE guards are switched off for this one transaction (the test role owns
 * the tables). Production code never does this.
 */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const present = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE tgname IN ('audit_logs_no_truncate', 'attendance_events_no_truncate')`;
  const guards = TRUNCATE_GUARDS.filter((g) => present.some((p) => p.tgname === g.trigger));
  await prisma.$transaction([
    ...guards.map((g) => prisma.$executeRawUnsafe(`ALTER TABLE "${g.table}" DISABLE TRIGGER "${g.trigger}"`)),
    prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`),
    ...guards.map((g) => prisma.$executeRawUnsafe(`ALTER TABLE "${g.table}" ENABLE TRIGGER "${g.trigger}"`)),
  ]);
  await ensureRbac(prisma);
}

/** Boots the full Nest application with production configuration. */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
