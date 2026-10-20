-- Remote work: a leave type flag that turns approved requests into remote working days instead of leave.
ALTER TABLE "leave_types" ADD COLUMN "is_remote_work" BOOLEAN NOT NULL DEFAULT false;

-- The seeded REMOTE_WORK type (it keeps no balance) becomes a remote-work type.
UPDATE "leave_types" SET "is_remote_work" = true
WHERE "code" = 'REMOTE_WORK' AND "accrual" = 'NONE' AND "annual_entitlement_minutes" = 0;
