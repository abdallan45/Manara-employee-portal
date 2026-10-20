-- Audit hardening.
-- 1. TRUNCATE bypasses the row-level append-only triggers, so block it with statement-level
--    triggers on the same tables (same error as the row triggers: forbid_mutation()).
-- 2. When the runtime role workforce_app exists (production, created by deploy/db-init), take
--    away UPDATE, DELETE and TRUNCATE on the append-only tables from it as well. The owner role
--    that runs migrations keeps its rights; table owners can always disable triggers.

CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER attendance_events_no_truncate BEFORE TRUNCATE ON "attendance_events"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workforce_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs", "attendance_events" FROM workforce_app;
    -- The runtime never needs the migration history.
    REVOKE ALL ON "_prisma_migrations" FROM workforce_app;
  END IF;
END
$$;
