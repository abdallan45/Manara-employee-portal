-- Company work hours become effective-dated rules; the latest rule on or before a day applies.
CREATE TABLE "work_hours_rules" (
    "id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "daily_required_minutes" INTEGER NOT NULL,
    "included_break_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    CONSTRAINT "work_hours_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_hours_rules_effective_from_key" ON "work_hours_rules"("effective_from");

-- Base rule from the current settings (or the old defaults), covering all history.
INSERT INTO "work_hours_rules" ("id", "effective_from", "daily_required_minutes", "included_break_minutes")
SELECT gen_random_uuid(), DATE '2000-01-01',
    COALESCE((SELECT ("value" #>> '{}')::int FROM "system_settings" WHERE "key" = 'attendance.dailyRequiredMinutes'), 540),
    COALESCE((SELECT ("value" #>> '{}')::int FROM "system_settings" WHERE "key" = 'attendance.includedBreakMinutes'), 60);
DELETE FROM "system_settings" WHERE "key" IN ('attendance.dailyRequiredMinutes', 'attendance.includedBreakMinutes');

-- Direct managers become supervisors of their reports.
INSERT INTO "employee_supervisors" ("id", "supervisor_user_id", "employee_id")
SELECT gen_random_uuid(), u."id", e."id"
FROM "employees" e JOIN "users" u ON u."employee_id" = e."manager_id"
WHERE e."manager_id" IS NOT NULL AND e."manager_id" <> e."id" AND u."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
