-- Per-employee work hours, approval chains (manager / role steps) for every request kind,
-- supervisors over individual employees, and two new built-in roles.

-- Employees: personal daily requirement and break allowance (null = company defaults in settings).
ALTER TABLE "employees" ADD COLUMN "daily_required_minutes" INTEGER,
  ADD COLUMN "included_break_minutes" INTEGER;

-- Supervisors (project managers) over individual employees.
CREATE TABLE "employee_supervisors" (
    "id" UUID NOT NULL,
    "supervisor_user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_supervisors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "employee_supervisors_employee_id_idx" ON "employee_supervisors"("employee_id");
CREATE UNIQUE INDEX "employee_supervisors_supervisor_user_id_employee_id_key" ON "employee_supervisors"("supervisor_user_id", "employee_id");
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_supervisor_user_id_fkey" FOREIGN KEY ("supervisor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_supervisors" ADD CONSTRAINT "employee_supervisors_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Roles: Arabic name.
ALTER TABLE "roles" ADD COLUMN "name_ar" TEXT;

-- Leave types: approval levels become an explicit chain.
-- 1 = manager; 2 = manager then HR; 3 = manager, HR, then the general manager.
ALTER TABLE "leave_types" ADD COLUMN "approval_steps" JSONB NOT NULL DEFAULT '["MANAGER"]';
UPDATE "leave_types" SET "approval_steps" = CASE
    WHEN "approval_levels" >= 3 THEN '["MANAGER","HR_ADMIN","GENERAL_MANAGER"]'::jsonb
    WHEN "approval_levels" = 2 THEN '["MANAGER","HR_ADMIN"]'::jsonb
    ELSE '["MANAGER"]'::jsonb END;
ALTER TABLE "leave_types" DROP COLUMN "approval_levels";

-- Leave requests keep the chain they were submitted with.
ALTER TABLE "leave_requests" ADD COLUMN "approval_steps" JSONB NOT NULL DEFAULT '["MANAGER"]';
UPDATE "leave_requests" r SET "approval_steps" = t."approval_steps" FROM "leave_types" t WHERE t."id" = r."leave_type_id";
ALTER TABLE "leave_approvals" ADD COLUMN "step" TEXT NOT NULL DEFAULT 'MANAGER';
UPDATE "leave_approvals" a SET "step" = COALESCE(r."approval_steps" ->> (a."level" - 1), CASE WHEN a."level" = 1 THEN 'MANAGER' ELSE 'HR_ADMIN' END)
  FROM "leave_requests" r WHERE r."id" = a."request_id";

-- Overtime: multi-step like leave.
ALTER TABLE "overtime_requests" ADD COLUMN "approval_steps" JSONB NOT NULL DEFAULT '["MANAGER"]',
  ADD COLUMN "current_level" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "overtime_approvals" ADD COLUMN "step" TEXT NOT NULL DEFAULT 'MANAGER';

-- Corrections: multi-step with a decision row per step.
ALTER TABLE "attendance_corrections" ADD COLUMN "approval_steps" JSONB NOT NULL DEFAULT '["MANAGER"]',
  ADD COLUMN "current_level" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "correction_approvals" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'MANAGER',
    "decision" "RequestStatus" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "correction_approvals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "correction_approvals_request_id_idx" ON "correction_approvals"("request_id");
ALTER TABLE "correction_approvals" ADD CONSTRAINT "correction_approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "attendance_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Past decisions become the history row of their single step.
INSERT INTO "correction_approvals" ("id", "request_id", "approver_user_id", "level", "step", "decision", "comment", "created_at")
  SELECT gen_random_uuid(), c."id", c."decided_by_id", 1, 'MANAGER', c."status", c."decision_comment", COALESCE(c."decided_at", c."created_at")
  FROM "attendance_corrections" c
  WHERE c."decided_by_id" IS NOT NULL AND c."status" IN ('APPROVED', 'REJECTED');

-- New built-in roles (later edits by the admin are kept: the seed only creates missing roles).
INSERT INTO "roles" ("id", "key", "name", "name_ar", "is_system")
VALUES (gen_random_uuid(), 'GENERAL_MANAGER', 'General Manager', 'المدير العام', true),
       (gen_random_uuid(), 'PROJECT_MANAGER', 'Project Manager', 'مدير مشروع', true)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."key" IN (
    'attendance.self', 'leave.self', 'overtime.self',
    'attendance.read.all', 'dashboard.read', 'employees.read', 'reports.read.all', 'reports.export',
    'leave.approve', 'overtime.approve', 'corrections.approve', 'audit.read')
WHERE r."key" = 'GENERAL_MANAGER'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."key" IN (
    'attendance.self', 'leave.self', 'overtime.self',
    'attendance.read.team', 'dashboard.read', 'employees.read', 'reports.read.team',
    'leave.approve', 'overtime.approve', 'corrections.approve')
WHERE r."key" = 'PROJECT_MANAGER'
ON CONFLICT DO NOTHING;
UPDATE "roles" SET "name_ar" = CASE "key"
    WHEN 'SUPER_ADMIN' THEN 'مدير النظام'
    WHEN 'HR_ADMIN' THEN 'الموارد البشرية'
    WHEN 'DEPARTMENT_MANAGER' THEN 'مدير قسم'
    WHEN 'EMPLOYEE' THEN 'موظف'
    ELSE "name_ar" END
WHERE "name_ar" IS NULL;
