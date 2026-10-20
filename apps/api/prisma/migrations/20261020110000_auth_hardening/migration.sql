-- Auth hardening: users whose password was set by an administrator (or the seeded admin)
-- must choose their own password before using the API.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
