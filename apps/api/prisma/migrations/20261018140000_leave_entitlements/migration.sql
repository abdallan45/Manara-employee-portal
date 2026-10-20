-- Personal yearly leave entitlements (seniority, contract) that replace a leave type's default from a given year.
CREATE TABLE "leave_entitlements" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type_id" UUID NOT NULL,
    "from_year" INTEGER NOT NULL,
    "annual_entitlement_minutes" INTEGER NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leave_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leave_entitlements_employee_id_leave_type_id_from_year_key" ON "leave_entitlements"("employee_id", "leave_type_id", "from_year");

ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_entitlements" ADD CONSTRAINT "leave_entitlements_leave_type_id_fkey"
    FOREIGN KEY ("leave_type_id") REFERENCES "leave_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
