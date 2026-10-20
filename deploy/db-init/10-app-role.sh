#!/bin/sh
# Creates the runtime database role "workforce_app" (no superuser, no DDL) next to the owner role
# POSTGRES_USER, which keeps owning the schema and runs the migrations.
#
# - Runs automatically once, when the db volume is first initialised (mounted into
#   /docker-entrypoint-initdb.d/).
# - Safe to run again on an existing database (see docs/deployment.md, "Database roles"):
#   docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec \
#     -e APP_DB_PASSWORD db sh /docker-entrypoint-initdb.d/10-app-role.sh
#   Re-running also resets the role's password to APP_DB_PASSWORD.
# The body runs in a subshell: the postgres entrypoint sources non-executable scripts, and the
# shell options and variables below must not leak into it. A failure still stops the init.
(
set -eu

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "10-app-role.sh: APP_DB_PASSWORD is not set; refusing to create workforce_app without a password" >&2
  exit 1
fi
if [ "$APP_DB_PASSWORD" = "${POSTGRES_PASSWORD:-}" ]; then
  echo "10-app-role.sh: APP_DB_PASSWORD must differ from POSTGRES_PASSWORD" >&2
  exit 1
fi

export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" -v owner="$POSTGRES_USER" <<'SQL'
-- Login role with no special attributes.
SELECT format('CREATE ROLE workforce_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workforce_app') \gexec
SELECT format('ALTER ROLE workforce_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO workforce_app', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO workforce_app;

-- Tables and sequences the owner creates later (migrations) are usable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workforce_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO workforce_app;

-- Existing objects (when run on a database that already has the schema).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workforce_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workforce_app;

-- Append-only tables: insert and read only. The migration 20261020120000_audit_hardening does the
-- same when it runs after this script; doing it here covers databases migrated before the role existed.
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM workforce_app;
  END IF;
  IF to_regclass('public.attendance_events') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.attendance_events FROM workforce_app;
  END IF;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM workforce_app;
  END IF;
END
$$;
SQL

echo "10-app-role.sh: role workforce_app is ready"
)
