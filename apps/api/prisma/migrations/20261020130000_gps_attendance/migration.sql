-- Attendance location check moves from the office network (client IP in trusted CIDRs) to device GPS.

-- Offices become geofences.
ALTER TABLE "locations" ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "radius_meters" INTEGER NOT NULL DEFAULT 150,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- Events keep the device location they were recorded with.
ALTER TABLE "attendance_events" DROP CONSTRAINT IF EXISTS "attendance_events_trusted_network_id_fkey";
ALTER TABLE "attendance_events" DROP COLUMN "trusted_network_id";
ALTER TABLE "attendance_events" RENAME COLUMN "network_verified" TO "location_verified";
ALTER TABLE "attendance_events" ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "accuracy_meters" DOUBLE PRECISION,
  ADD COLUMN "distance_meters" DOUBLE PRECISION,
  ADD COLUMN "office_id" UUID;
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_office_id_fkey"
  FOREIGN KEY ("office_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "work_sessions" RENAME COLUMN "network_verified" TO "location_verified";

DROP TABLE "trusted_networks";

-- Same permission, new name: whoever managed networks now manages office locations.
UPDATE "permissions" SET "key" = 'offices.manage', "description" = 'Manage office locations (GPS check-in area)'
  WHERE "key" = 'networks.manage';

-- Settings: the network rule is replaced by the location rule (same ENFORCE / FLAG choice).
UPDATE "system_settings" SET "key" = 'attendance.locationEnforcement' WHERE "key" = 'attendance.networkEnforcement';
