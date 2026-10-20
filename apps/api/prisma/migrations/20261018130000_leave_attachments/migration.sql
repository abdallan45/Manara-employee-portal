-- Supporting documents (image / PDF) of leave requests, stored in the database so backups include them.
CREATE TABLE "leave_attachments" (
    "id" UUID NOT NULL,
    "leave_request_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leave_attachments_leave_request_id_idx" ON "leave_attachments"("leave_request_id");

ALTER TABLE "leave_attachments" ADD CONSTRAINT "leave_attachments_leave_request_id_fkey"
    FOREIGN KEY ("leave_request_id") REFERENCES "leave_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
