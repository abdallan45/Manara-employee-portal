-- Nouria (talking mascot): admin-managed groups of lines; recordings stored in the database so backups include them.
-- CreateEnum
CREATE TYPE "MascotTrigger" AS ENUM ('GREETING', 'CHECK_IN', 'CHECK_OUT', 'BREAK_START', 'BREAK_END', 'ERROR', 'POKE');

-- CreateTable
CREATE TABLE "mascot_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "MascotTrigger" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "moods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mascot_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mascot_lines" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mood" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "audio" BYTEA,
    "audio_mime" TEXT,
    "audio_sha256" TEXT,
    "audio_size" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mascot_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mascot_groups_trigger_idx" ON "mascot_groups"("trigger");

-- CreateIndex
CREATE INDEX "mascot_lines_group_id_idx" ON "mascot_lines"("group_id");

-- AddForeignKey
ALTER TABLE "mascot_lines" ADD CONSTRAINT "mascot_lines_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "mascot_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "mascot_lines" ADD CONSTRAINT "mascot_lines_locale_check" CHECK ("locale" IN ('ar', 'en'));
