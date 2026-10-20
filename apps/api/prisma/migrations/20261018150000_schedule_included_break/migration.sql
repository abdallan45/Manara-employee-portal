-- Break time that is part of the working day (e.g. a 9-hour day including a 1-hour break); 0 keeps the previous behaviour.
ALTER TABLE "work_schedules" ADD COLUMN "included_break_minutes" INTEGER NOT NULL DEFAULT 0;
