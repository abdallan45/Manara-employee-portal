# Architecture

## Monorepo

```
apps/
  api/        NestJS 11 REST API (/api/v1), Prisma 6, PostgreSQL. Also serves the web build.
    prisma/   schema.prisma, migrations/, seed.ts, rbac.ts
    src/
      common/   Prisma service, AppError, auth decorators/guards, time (Asia/Amman), scopes
      modules/  auth, audit, settings, employees, departments,
                offices, schedules, attendance, dashboard, notifications,
                requests (leave, overtime, corrections, approval center)
    test/     integration tests against the workforce_test database
  web/        Next.js 15 (App Router) static export, Tailwind 4, shadcn/ui, Recharts
packages/
  shared/     API contract shared by API, web and the future Flutter app:
              permissions catalog, DTOs, error codes, setting keys
deploy/       Docker Compose, Caddy (internal HTTPS), backup script
docs/         this folder
dev/          local Postgres without Docker (embedded-postgres) for development
legacy/       the first prototype (single-file API + vanilla PWA), kept for reference
```

One origin: the API serves the exported web app from `apps/web/out`, so cookies, CSRF and
the geolocation permission all use the same host. During development, `next dev` on :3001 proxies
`/api` to the API on :3000.

## Request path

```
Browser / future app ──HTTPS──▶ Caddy (LAN only) ──HTTP──▶ app:3000
                                                        ├─ /api/v1/*   NestJS
                                                        └─ /*          static web export
```

Global guards, in order: rate limit -> authentication (cookie session or bearer token) ->
CSRF (cookie sessions, unsafe methods) -> permissions. Errors always use one envelope:
`{ error: { code, message, details }, statusCode, path, timestamp }`.

## Attendance engine

State per employee: `OFF -> WORKING ⇄ ON_BREAK -> OFF`.

| Action | Allowed from | Effect |
|---|---|---|
| CHECK_IN | OFF | event + new work session (work date = Amman date of check-in) |
| BREAK_START | WORKING | event + break session of a break type |
| BREAK_END | ON_BREAK | event, closes the break |
| CHECK_OUT | WORKING or ON_BREAK | auto-ends an open break, then closes the session |

Every action: one transaction, row lock on the employee, idempotency key, audit entry. Check-in
and check-out also carry the device location, checked against the office geofences
(`offices/geofence.service.ts`; ENFORCE rejects, FLAG records and marks for review); the position,
accuracy, distance and office are stored on the event. On a date covered by approved remote work
(below) any location is accepted in both modes; the events keep `locationVerified = false` and
carry `metadata.remote = true` (also in the audit entries). A session left open past
`attendance.maxOpenSessionHours` becomes `MISSING_CHECKOUT`: it counts zero hours until a
correction is approved, and the employee and their managers are notified.

Raw facts (events, sessions, breaks) are stored; all totals (net hours, late minutes, extra
hours, paid/unpaid breaks) are computed by one pure module, `attendance/calc.ts`, used by
the employee portal, the dashboards and later the timesheets and exports.

## Schedules

Resolution order for an employee on a date: personal assignment -> department assignment ->
default schedule. `FIXED` schedules measure lateness against the start time plus grace.
`FLEXIBLE` schedules are never "late" against a fixed start; with core hours they report
late arrival after core start, missing core minutes, and early departure before core end;
without core hours they only compare worked vs required hours. Overnight shifts belong to
the date they start.

## Requests and approvals

`modules/requests` holds three workflows and one inbox. Every mutation runs in one transaction
that takes the same employee row lock as the attendance engine and writes an audit row and the
notifications for the people involved.

**Leave.** Balances are never stored: `leave_transactions` is a ledger per employee, type and
year (ACCRUAL, CARRYOVER, ADJUSTMENT, USAGE, CANCELLATION). A year is opened lazily on first
use: the yearly grant (prorated by the days remaining in the hire year) or the monthly accrual
rows due so far, plus the previous year's unused balance capped at `carryoverMaxMinutes`. A
request costs the scheduled minutes of the working days it covers (weekends and holidays are
free); half days split the shift; hourly leave uses the given times. Requests overlapping a
pending or approved one, or larger than `balance − pending`, are refused. Approval posts a USAGE
row; cancelling approved leave posts the matching CANCELLATION credit. Approved leave feeds
`calc.ts` through `attendance/leave-days.ts`: full days set `onLeave` (status ON_LEAVE, nothing
required), half-day and hourly leave lower the day's required minutes.

**Remote work** is requested like leave but is a working day, not leave. A leave type with
`isRemoteWork` (seeded `REMOTE_WORK`; Settings -> Leave types -> "Remote work") must keep no balance
(accrual NONE, no entitlement), so approval posts no ledger rows. `leave-days.ts` turns an approved
request of such a type into `remote: true` instead of `onLeave` / `leaveMinutes`, in any mode: the
schedule applies unchanged (required minutes, lateness, ABSENT without a check-in) and
`DayMetrics.remote` marks the day so the UI shows a "Remote" badge (day tables, live attendance,
employee page, the employee home). The location rule is waived for the whole local date of
the request (`AttendanceService.remoteOn`; `GET /attendance/me/status` returns `location.remote`);
full-day leave on the same date wins over remote work.

**Approval levels** (`approval-routing.ts`): level 1 is the department manager, levels 2…N are
HR (users with the approve permission and company-wide attendance access). The manager step is
skipped for sensitive types or when the department has no other manager. HR may act at any
level; nobody decides their own request or approves two levels of one request; a rejection at
any level is final and needs a reason. Sensitive types never reach managers: they are left out
of their inbox and shown as "confidential leave" without type or reason elsewhere.

**Overtime.** Requests for today or later are pre-approvals; past days are retrospective (if the
policy allows them) and capped at the extra minutes `calc.ts` reports for that day - checked
again on approval. The day kind (workday / rest day / holiday) comes from the schedule resolver;
the multiplier comes from the `OvertimePolicy` and is stored on the request, so later policy
edits do not change it. Compensation estimates are minutes × multiplier in integer arithmetic;
no statutory rate is hard-coded.

**Corrections.** Missing check-out (closes a MISSING_CHECKOUT session), wrong check-in or
check-out time, and a wholly missing session. Approval re-validates against the current records,
then appends ADMIN_CORRECTION events (metadata: correction id, superseded event) and points the
session at them. Existing events are never updated or deleted.

**Direct HR corrections.** `POST /corrections/direct` (body: `employeeId` plus the correction
request body; a reason is required) lets a holder of `attendance.correct` with company-wide access
(`attendance.read.all`, i.e. HR / Super Admin) fix an employee's attendance at once. It runs the same
validation under the employee lock and the same apply step as an approved request, then stores an
APPROVED correction whose requester and approver are the HR user (`direct: true` in the DTO), so it
appears in the employee's history and the Approval Center's approved tab. Audit rows
(`CORRECTION_DIRECT_APPLY`, `ATTENDANCE_CORRECTION_APPLIED`) are written in the same transaction and
the employee gets a notification. Nobody can correct their own attendance this way. HR reads an
employee's last 31 days of sessions and their corrections with `GET /corrections/employees/:id/sessions`
and `GET /corrections/employees/:id/requests`. UI: employee page -> **Correct attendance**.

**Approval Center** (`/approvals`): pending / approved / rejected across the three types within
the viewer's scope, actionable items first; approve or reject with a comment; bulk approve runs
each item in its own transaction and reports per-item results.

**Configuration.** Leave types (`GET/POST /leave/types`, `PATCH /leave/types/:id`,
`leave-types.service.ts`) and the overtime policy (`PATCH /overtime/policies/:id`) are company
settings gated by `settings.manage` - the same permission as the other system rules, because
they change entitlements and pay estimates for everyone (HR Admin does not have it by default).
The code of a leave type is fixed once created; types are never deleted, only deactivated
(`isActive: false`: hidden from new requests and balances, history kept). A type without
accrual cannot carry an entitlement or carryover. Entitlement edits apply to years opened
afterwards and to monthly accruals not yet posted; rows already in the ledger are not rewritten,
so HR corrects existing balances with adjustments (`POST /leave/adjustments`, leave approvers
with company-wide scope). Every change is audited with before/after in the same transaction.
UI: Settings -> Leave types / Overtime policy, and the Leave tab of the employee page.

**Employee portal visibility.** The system setting `portal.visibility` (validated by
`validatePortalVisibility` in `packages/shared/src/portal.ts`) maps page and section keys to booleans;
a missing key means visible and the locked pages (My day, My attendance, Notifications) cannot be
hidden. `/auth/me` returns the effective map as `SessionUser.portal`; the web hides menu items and
guards routes with it, and `PortalVisibilityInterceptor` (global) refuses `POST` leave, overtime and
correction requests (and their previews) for hidden pages or sections with 403 `PORTAL_DISABLED`.
Reads stay open, so balances, history and admin screens are unaffected.

## Reports

`modules/reports` (`GET /reports/attendance?from&to&departmentId&employeeId`) sums the same
`calc.ts` day figures the dashboard uses, through `AttendanceMetricsService.computeRange`, plus
approved and pending overtime requests (compensation = approved minutes × the multiplier stored
on each request). Days after today are ignored. Presence counts scheduled days only; rest-day
work is reported separately, so the attendance rate is present ÷ (scheduled − full-day leave).
Remote days are not leave: `remoteDays` counts scheduled remote days with a check-in (they are also
in `presentDays`); a remote day without a check-in is absent.
Scope follows `reports.read.all` (everyone) or `reports.read.team` (managed departments; other
departments or employees are 403). With `employeeId` the row includes the daily figures, which
the employee page uses. CSV export is built in the browser from the report (UTF-8 with BOM for
Excel), shown only with `reports.export`.

## Leave documents

`LeaveDocumentsService` (`POST /leave/requests/:id/documents`, `GET /leave/documents/:id/content`,
`DELETE /leave/documents/:id`) stores files in `leave_attachments` (bytea, with SHA-256), never on
the file system, so backups and restores stay one step. The content type comes from the file's
first bytes, not from the browser or the file name. The requester adds documents while the
request is pending or approved and removes their own while pending; HR (leave approvers with
company-wide scope) may add or remove on any non-cancelled request. Opening follows the request's
visibility, and sensitive types stay hidden from department managers. Adds and removals are audited
inside the transaction; a row lock on the request keeps the five-document limit under concurrent uploads.

## Data model highlights

UUID keys, UTC `timestamptz`, `date` columns for local calendar dates, soft delete where
records are referenced by history (users, employees, departments), append-only triggers on
events and audit logs, ledgers instead of stored balances (leave transactions).

## Roadmap

Working today: login and roles, employees and departments, attendance and breaks with the location
check, schedules and holidays, leave, overtime, corrections and approvals, dashboards and reports,
and the Nouria mascot.

Still to do: monthly timesheet closing, PDF export, running the HTTPS setup on the real server,
a backup restore drill, and browser end-to-end tests.
