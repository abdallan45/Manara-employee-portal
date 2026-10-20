-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('FIXED', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "AttendanceEventType" AS ENUM ('CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('WEB', 'MOBILE', 'ADMIN_CORRECTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "WorkSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'MISSING_CHECKOUT');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "employee_id" UUID,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "department_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_hash" TEXT,
    "client" TEXT NOT NULL DEFAULT 'WEB',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Amman',
    "address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_networks" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "location_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "employee_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "full_name_ar" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "job_title" TEXT,
    "department_id" UUID,
    "location_id" UUID,
    "manager_id" UUID,
    "hire_date" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registered_devices" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "fingerprint_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "registered_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_schedules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ScheduleType" NOT NULL,
    "weekly_required_minutes" INTEGER NOT NULL,
    "grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "core_start_minute" INTEGER,
    "core_end_minute" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_days" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "is_workday" BOOLEAN NOT NULL,
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "required_minutes" INTEGER NOT NULL,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_assignments" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "employee_id" UUID,
    "department_id" UUID,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "location_id" UUID,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "AttendanceEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "source" "EventSource" NOT NULL,
    "ip_address" INET NOT NULL,
    "network_verified" BOOLEAN NOT NULL,
    "trusted_network_id" UUID,
    "device_id" UUID,
    "idempotency_key" UUID NOT NULL,
    "actor_user_id" UUID,
    "work_session_id" UUID,
    "break_session_id" UUID,
    "break_type_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_sessions" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "status" "WorkSessionStatus" NOT NULL DEFAULT 'OPEN',
    "start_event_id" UUID NOT NULL,
    "end_event_id" UUID,
    "network_verified" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "max_minutes" INTEGER,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "counts_as_work" BOOLEAN NOT NULL DEFAULT false,
    "notify_after_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "break_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_sessions" (
    "id" UUID NOT NULL,
    "work_session_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "break_type_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "start_event_id" UUID NOT NULL,
    "end_event_id" UUID,
    "auto_closed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "break_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "event_type" "AttendanceEventType" NOT NULL,
    "proposed_time" TIMESTAMPTZ(3) NOT NULL,
    "work_session_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_comment" TEXT,
    "applied_event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "regular_multiplier" DECIMAL(5,2) NOT NULL,
    "weekend_multiplier" DECIMAL(5,2) NOT NULL,
    "holiday_multiplier" DECIMAL(5,2) NOT NULL,
    "minimum_minutes" INTEGER NOT NULL DEFAULT 15,
    "requires_pre_approval" BOOLEAN NOT NULL DEFAULT true,
    "allow_retro_approval" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "compensation" TEXT NOT NULL DEFAULT 'PAY',
    "is_pre_approval" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "overtime_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overtime_approvals" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "decision" "RequestStatus" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overtime_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "unit" TEXT NOT NULL DEFAULT 'DAY',
    "annual_entitlement_minutes" INTEGER NOT NULL DEFAULT 0,
    "accrual" TEXT NOT NULL DEFAULT 'YEARLY',
    "carryover_max_minutes" INTEGER NOT NULL DEFAULT 0,
    "requires_attachment" BOOLEAN NOT NULL DEFAULT false,
    "approval_levels" INTEGER NOT NULL DEFAULT 1,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_balances" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_transactions" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "request_id" UUID,
    "note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "current_level" INTEGER NOT NULL DEFAULT 1,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_approvals" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "approver_user_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "decision" "RequestStatus" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_periods" (
    "id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,

    CONSTRAINT "timesheet_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timesheet_approvals" (
    "id" UUID NOT NULL,
    "period_id" UUID NOT NULL,
    "employee_id" UUID,
    "approver_user_id" UUID NOT NULL,
    "decision" "RequestStatus" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_roles_department_id_idx" ON "user_roles"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_department_id_key" ON "user_roles"("user_id", "role_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_networks_cidr_key" ON "trusted_networks"("cidr");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_code_key" ON "employees"("employee_code");

-- CreateIndex
CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "registered_devices_employee_id_fingerprint_hash_key" ON "registered_devices"("employee_id", "fingerprint_hash");

-- CreateIndex
CREATE UNIQUE INDEX "work_schedules_name_key" ON "work_schedules"("name");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_days_schedule_id_weekday_key" ON "schedule_days"("schedule_id", "weekday");

-- CreateIndex
CREATE INDEX "schedule_assignments_employee_id_valid_from_idx" ON "schedule_assignments"("employee_id", "valid_from");

-- CreateIndex
CREATE INDEX "schedule_assignments_department_id_valid_from_idx" ON "schedule_assignments"("department_id", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "holidays_date_location_id_key" ON "holidays"("date", "location_id");

-- CreateIndex
CREATE INDEX "attendance_events_employee_id_occurred_at_idx" ON "attendance_events"("employee_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "attendance_events_occurred_at_idx" ON "attendance_events"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_employee_id_idempotency_key_key" ON "attendance_events"("employee_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "work_sessions_start_event_id_key" ON "work_sessions"("start_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_sessions_end_event_id_key" ON "work_sessions"("end_event_id");

-- CreateIndex
CREATE INDEX "work_sessions_employee_id_work_date_idx" ON "work_sessions"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "work_sessions_work_date_idx" ON "work_sessions"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "break_types_code_key" ON "break_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "break_sessions_start_event_id_key" ON "break_sessions"("start_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "break_sessions_end_event_id_key" ON "break_sessions"("end_event_id");

-- CreateIndex
CREATE INDEX "break_sessions_work_session_id_idx" ON "break_sessions"("work_session_id");

-- CreateIndex
CREATE INDEX "break_sessions_employee_id_started_at_idx" ON "break_sessions"("employee_id", "started_at");

-- CreateIndex
CREATE INDEX "attendance_corrections_employee_id_status_idx" ON "attendance_corrections"("employee_id", "status");

-- CreateIndex
CREATE INDEX "attendance_corrections_status_idx" ON "attendance_corrections"("status");

-- CreateIndex
CREATE UNIQUE INDEX "overtime_policies_name_key" ON "overtime_policies"("name");

-- CreateIndex
CREATE INDEX "overtime_requests_employee_id_work_date_idx" ON "overtime_requests"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "overtime_requests_status_idx" ON "overtime_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_code_key" ON "leave_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "leave_balances_employee_id_leave_type_id_year_key" ON "leave_balances"("employee_id", "leave_type_id", "year");

-- CreateIndex
CREATE INDEX "leave_transactions_employee_id_leave_type_id_year_idx" ON "leave_transactions"("employee_id", "leave_type_id", "year");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_start_at_idx" ON "leave_requests"("employee_id", "start_at");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "timesheet_periods_start_date_end_date_key" ON "timesheet_periods"("start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_seq_key" ON "audit_logs"("seq");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_idx" ON "audit_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_networks" ADD CONSTRAINT "trusted_networks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registered_devices" ADD CONSTRAINT "registered_devices_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "work_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "work_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_trusted_network_id_fkey" FOREIGN KEY ("trusted_network_id") REFERENCES "trusted_networks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_work_session_id_fkey" FOREIGN KEY ("work_session_id") REFERENCES "work_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_break_type_id_fkey" FOREIGN KEY ("break_type_id") REFERENCES "break_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overtime_approvals" ADD CONSTRAINT "overtime_approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "overtime_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_transactions" ADD CONSTRAINT "leave_transactions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_transactions" ADD CONSTRAINT "leave_transactions_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_transactions" ADD CONSTRAINT "leave_transactions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_fkey" FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_approvals" ADD CONSTRAINT "leave_approvals_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_approvals" ADD CONSTRAINT "timesheet_approvals_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "timesheet_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_approvals" ADD CONSTRAINT "timesheet_approvals_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────── Integrity rules Prisma cannot express ─────────

-- At most one open work session and one open break per employee (backstop for the row lock).
CREATE UNIQUE INDEX "work_sessions_one_open_per_employee" ON "work_sessions"("employee_id") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "break_sessions_one_open_per_employee" ON "break_sessions"("employee_id") WHERE "ended_at" IS NULL;

ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_end_after_start" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_end_after_start" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_weekday" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_minutes" CHECK (
  ("start_minute" IS NULL OR "start_minute" BETWEEN 0 AND 1439) AND
  ("end_minute" IS NULL OR "end_minute" BETWEEN 0 AND 1439) AND "required_minutes" BETWEEN 0 AND 1440);
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_core" CHECK (
  ("core_start_minute" IS NULL) = ("core_end_minute" IS NULL) AND
  ("core_start_minute" IS NULL OR ("core_start_minute" BETWEEN 0 AND 1439 AND "core_end_minute" BETWEEN 0 AND 1439)));
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_target" CHECK (("employee_id" IS NULL) <> ("department_id" IS NULL));
ALTER TABLE "schedule_assignments" ADD CONSTRAINT "schedule_assignments_range" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");
ALTER TABLE "break_types" ADD CONSTRAINT "break_types_limits" CHECK (("max_minutes" IS NULL OR "max_minutes" > 0) AND ("notify_after_minutes" IS NULL OR "notify_after_minutes" > 0));
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_range" CHECK ("end_at" > "start_at" AND "minutes" > 0);
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_minutes" CHECK ("minutes" > 0);

-- Append-only tables: history can be corrected only by adding new rows.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER attendance_events_append_only BEFORE UPDATE OR DELETE ON "attendance_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
