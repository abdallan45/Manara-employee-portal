-- Leave, overtime and correction workflows (phase 3/4).

-- Leave requests: request mode (full day / half day / hourly) and the final decision time.
ALTER TABLE "leave_requests" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'FULL_DAY';
ALTER TABLE "leave_requests" ADD COLUMN "decided_at" TIMESTAMPTZ(3);
CREATE INDEX "leave_requests_employee_id_end_at_idx" ON "leave_requests"("employee_id", "end_at");

-- Overtime requests: policy terms captured at request time and the minutes accepted on approval.
ALTER TABLE "overtime_requests" ADD COLUMN "policy_id" UUID;
ALTER TABLE "overtime_requests" ADD COLUMN "multiplier" DECIMAL(5,2);
ALTER TABLE "overtime_requests" ADD COLUMN "approved_minutes" INTEGER;

-- Attendance corrections: check-out time of a wholly missing session (MISSING_CHECK_IN).
ALTER TABLE "attendance_corrections" ADD COLUMN "proposed_end_time" TIMESTAMPTZ(3);
