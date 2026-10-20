# Security model and limitations

## What the system guarantees

- **Server time only.** Attendance timestamps come from the database clock
  (`clock_timestamp()`); nothing the client sends can set the time.
- **Append-only history.** `attendance_events` and `audit_logs` reject `UPDATE`,
  `DELETE` and `TRUNCATE` with database triggers. In production the API also connects as
  `workforce_app`, a role without superuser rights that has no `UPDATE`, `DELETE` or
  `TRUNCATE` permission on those two tables and cannot change the schema or disable
  triggers. Corrections are new rows (correction requests, approved by an authorised
  user), never edits.
- **Approvals.** Nobody can decide their own request; department managers only decide
  requests from departments they manage and never see sensitive leave types; every
  decision is re-checked on the server inside its transaction and audited.
- **Tamper-evident audit trail.** Every audit row stores the hash of the previous row.
  With `AUDIT_HMAC_KEY` set, each link is an HMAC-SHA256 under that key (stored as
  `h1:...`), so someone who can write to the database but does not hold the key cannot
  rebuild the chain after editing it. Older rows written without a key (plain SHA-256)
  still verify; a plain row after a keyed row counts as a break. *Audit logs -> Verify
  integrity* recomputes the chain and reports the first broken row (the reason is in the
  API log). Every backup also writes an anchor file with the newest `seq` and hash, so
  cutting rows off the end of the chain is detected by comparing with older anchors.
- **No duplicate or racing punches.** Each action runs in one transaction with a row lock
  on the employee, an idempotency key per request (a retried request returns the original
  result), and partial unique indexes allowing only one open session and one open break per
  employee.
- **Permissions enforced on the server.** Every endpoint checks role permissions;
  department managers only see their own departments. The web app hiding a button is a
  convenience, not the control.
- **Passwords and sessions.** Argon2id hashing; opaque session tokens of which only a
  SHA-256 hash is stored; HTTP-only, `SameSite=Strict` cookies for the browser with a
  CSRF token on state-changing requests; bearer tokens for future mobile apps; login
  rate-limiting and account lockout; deactivating a user ends their sessions.

## Location-based attendance: what it proves and what it doesn't

Check-in and check-out carry the device position from the browser Geolocation API (or the
mobile app): latitude, longitude and the accuracy the device reports. The server accepts the
action only when that position is within the radius of an active office under
**Settings -> Office locations** and the accuracy is no worse than
`attendance.maxLocationAccuracyMeters` (default 150 m). In `FLAG` mode it accepts anyway and
marks the event for review (`locationVerified = false`, `metadata.locationProblem`). Breaks
do not need a location. Every check-in and check-out stores the position, its accuracy, the
distance to the nearest office and which office it was; denied attempts are audited as
`ATTENDANCE_DENIED_LOCATION` with the position.

It **proves** that the device the employee used reported a position inside the office area.

It **does not prove**:

- **That the position is real.** The client reports it, so it can be faked: "mock location"
  apps on Android, the sensors panel in desktop browser developer tools, or a modified app.
  This stops the casual "check in from home" but not a determined user. Review unverified
  events and denied attempts in the audit log, and spot-check stored positions (map link in
  the event list).
- **That the account owner is the person pressing the button.** Someone with another
  employee's password, or their unlocked phone, can punch for them. Mitigations: personal
  devices with screen locks, the future registered-device check, periodic manager review.
- **Precision indoors.** Phones usually report 5-50 m, worse inside buildings; laptops have no
  GPS and estimate from nearby Wi-Fi, sometimes hundreds of metres off. Choose the office
  radius with that in mind (100-200 m is typical) and prefer phones for check-in.

Geolocation only works in a secure context (HTTPS or localhost) and after the employee allows
it. `Permissions-Policy` allows `geolocation=(self)` for this site only. The position is read
**only at the moment of check-in or check-out**; there is no background tracking. Tell
employees this in the company policy.

**Remote work** deliberately waives the location check: on a date covered by an approved request
of a remote-work leave type, check-in and check-out from anywhere are accepted (still
`locationVerified = false`, with `metadata.remote = true`). Approve remote work as carefully as
leave.

## Extension points for stronger verification

- `registered_devices` and `attendance_events.device_id` are in the schema for
  registered-device verification: binding a mobile app or browser install to an employee
  and requiring a known device for attendance.
- The event `metadata` column and the `source` field (`WEB`, `MOBILE`, …) let QR-code or
  biometric checks from the future Flutter app be recorded alongside the location result
  without changing the event model.

## Known gaps

- The audit chain proves edits only against the key and the anchors. Someone holding both
  the database owner password and `AUDIT_HMAC_KEY` can rewrite the chain; someone with
  only database rights can still replace the whole chain with plain SHA-256 rows from the
  first row on. Both show up when the live chain is compared with anchors kept off the
  server (`deploy/backup/check-anchors.sh`).
- The database owner (`POSTGRES_USER`) is still a superuser and is used for migrations and
  backups. Its password lives in `deploy/.env` and in the app container's environment for
  `prisma migrate deploy`; protect the server accordingly.
- `script-src` drops `'unsafe-inline'` only when the web build ships `csp-hashes.json`;
  without it the API logs a warning and keeps `'unsafe-inline'`. `style-src` keeps
  `'unsafe-inline'`.

- Internal HTTPS is configured in `deploy/` but has not been tested on a server yet.
  Do not use real passwords over plain HTTP.
- No password reset flow yet; an administrator sets a new password.
- No multi-factor authentication.
- Timesheet closing and exports are scheduled for a later phase.
- Leave documents are checked by their first bytes (JPEG, PNG, WebP, PDF only, 5 MB) and served
  with `X-Content-Type-Options: nosniff`, but they are not virus-scanned; HR should open them
  with an up-to-date viewer.
- A user holding both a department manager grant and company-wide access acts as HR everywhere.

## Go-live checklist

- [ ] `deploy/.env` has unique, long secrets; `DEMO_MODE` is not `true`.
- [ ] `APP_DB_PASSWORD` set and different from `POSTGRES_PASSWORD`; the role `workforce_app`
      exists (`\du` in psql) and the app connects with it.
- [ ] `AUDIT_HMAC_KEY` set (32+ random characters) and a copy stored outside the server; the
      app log shows no "AUDIT_HMAC_KEY is not set" warning.
- [ ] `BACKUP_PASSPHRASE` set and a copy stored outside the server; backups end in `.dump.enc`.
- [ ] Anchor files (`*.anchor.txt`) are copied off the server with the backups, and
      `check-anchors.sh` reports no problems.
- [ ] The API log shows "CSP script-src allows N inline script hash(es)", not the
      `'unsafe-inline'` warning.
- [ ] Seeded passwords changed; demo employees deleted.
- [ ] Trusted networks contain only staff subnets; guest Wi-Fi and VPN pools excluded. The API
      refuses `0.0.0.0/0`, `::/0`, ranges wider than /8 (IPv4) or /32 (IPv6), link-local,
      multicast and (in production) loopback, but entries saved before this check are kept:
      review them.
- [ ] Firewall allows 80/443 only from staff subnets; no internet port-forward.
- [ ] Internal root certificate installed on company devices; site opens over HTTPS without warnings.
- [ ] A test restore from the nightly backup has succeeded.
- [ ] Audit log integrity check returns "valid".
