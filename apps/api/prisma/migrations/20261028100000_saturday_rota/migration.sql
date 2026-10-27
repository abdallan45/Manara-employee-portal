-- Alternating Saturdays: departments and employees belong to rota group A or B.
ALTER TABLE "departments" ADD COLUMN "saturday_group" TEXT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_saturday_group_check" CHECK ("saturday_group" IN ('A', 'B'));

-- NONE opts the employee out of the department's group; null inherits it.
ALTER TABLE "employees" ADD COLUMN "saturday_group" TEXT;
ALTER TABLE "employees" ADD CONSTRAINT "employees_saturday_group_check" CHECK ("saturday_group" IN ('A', 'B', 'NONE'));
