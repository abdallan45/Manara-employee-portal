# Employee Portal (بوابة الموظف): attendance & workforce management

Formerly "Manara Workforce"; the npm workspaces keep the `@workforce/*` names.

On-premise attendance platform for a 10–50 person company. Employees check in/out and take
breaks from the office on phone or laptop (device location check). Managers and HR monitor attendance live.
Arabic and English with RTL support, in the Manara brand.

**Stack:** NestJS 11 · Prisma 6 · PostgreSQL · Next.js 15 (static export) · Tailwind 4 ·
shadcn/ui · Recharts · TypeScript (strict) · npm workspaces monorepo.

- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Public VPS deployment (Let's Encrypt HTTPS): [`docs/deployment-vps.md`](docs/deployment-vps.md)
- Security model and the limits of location-based attendance: [`docs/security.md`](docs/security.md)
- Server deployment (Docker, internal HTTPS, firewall, backups/restore): [`docs/deployment.md`](docs/deployment.md)

## Run locally (Windows/macOS/Linux, no Docker)

Requires Node.js 22+ (developed on Node 24).

```sh
npm install

# 1. Database: a local PostgreSQL on 127.0.0.1:5433 (keep this terminal open)
npm run dev:db

# 2. One-time: configure the API (dev:db already created the workforce + workforce_test databases)
#    (see apps/api/.env.example; for local use set DEMO_MODE=true to get one-click demo logins)
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL password to dev-only-password
npm run db:migrate                          # dev database
DATABASE_URL="postgresql://attendance:dev-only-password@127.0.0.1:5433/workforce_test?schema=public" npm run db:migrate   # test database
npm run db:seed                             # credentials -> apps/api/.seed-credentials.txt

# 3. Build and start (API + web app on one port)
npm run build
npm start                                   # http://127.0.0.1:3000  ·  API docs: /api/docs
```

Open `http://127.0.0.1:3000` on the same machine, or `http://<this PC's LAN IP>:3000` from a
phone on the office Wi-Fi. Check-in and check-out are accepted only near an office set under
**Settings -> Office locations** (the demo seed puts a made-up office in Amman; set your own).
Browsers share the device location only over HTTPS or on localhost.

For frontend work with hot reload, run `npm run dev:web` (port 3001, proxies `/api` to 3000)
alongside the API (`npm run dev:api`).

### Seeded demo data (fictional)

`admin` (Super Admin), `hr` (HR Admin), `manager` (Engineering manager) and six employees
across Operations, Engineering and Creative Studio. Passwords are generated per run and
written to `apps/api/.seed-credentials.txt` (git-ignored), or taken from
`SEED_DEFAULT_PASSWORD`. With `DEMO_MODE=true` the login page shows one-click buttons for
every account. **Never enable demo mode on a real server.**

To see a lived-in month, run `npm run db:demo-month -w @workforce/api` once after seeding. It adds
30 days of fictional attendance for the demo people (late mornings, long lunches, early
departures, an absence, forgotten check-outs, overtime evenings) and sends leave, overtime and
correction requests through the real services: some approved, some rejected, and a few left
pending in the Approval Center. It only runs with `DEMO_MODE=true`, skips days that already have
a session, and refuses a second run (attendance events are append-only and cannot be removed).

## Tests

```sh
npm test            # API: unit + integration tests against the workforce_test database
npm run lint -w @workforce/web
```

The integration tests truncate `workforce_test`; don't run two test processes at once.

| Suite | Covers |
|---|---|
| `calc.spec.ts` | fixed/flexible schedules, grace, core hours, overnight shifts, breaks (paid/unpaid/excess/counts-as-work), missing punch, holidays |
| `attendance.engine.e2e-spec.ts` | state machine, invalid transitions, idempotency, 5 concurrent check-ins -> 1 session, location ENFORCE/FLAG, stale sessions, append-only events, dashboard numbers, alert job |
| `attendance.http.e2e-spec.ts` | the same flows over HTTP with real auth guards and permission checks |
| `auth.e2e-spec.ts` | login, lockout, cookie + CSRF, bearer tokens, logout, rate limiting |
| `employees.e2e-spec.ts` | CRUD, conflicts, department-scoped visibility, privilege rules, deactivation ends sessions |
| `audit.e2e-spec.ts` | hash-chain verification, append-only trigger |
| `leave-math`, `overtime-math`, `approval-routing`, `leave-days` (`*.spec.ts`) | ledger summaries, yearly/monthly accrual and proration, carryover cap, request cost (full/half/hourly), compensation estimates, approval routing, leave -> calc inputs |
| `leave.e2e-spec.ts` | balances from the ledger, carryover, HR adjustments, overlap and balance checks, manager -> HR levels, self-approval, sensitive leave masking, rejection, cancellation credits, ON_LEAVE in attendance and dashboard |
| `leave-types.e2e-spec.ts` | leave type create / update / deactivate: settings.manage only, validation and accrual consistency, duplicate codes, audit before/after, inactive types hidden from requests and balances, posted ledger rows untouched |
| `reports.e2e-spec.ts` | attendance report totals (presence, absence, leave, rest-day work, extra time, approved overtime with multiplier), daily figures for one employee, manager scope, range validation |
| `leave-documents.e2e-spec.ts` | document upload (type checked from content, size and count limits), who may add / open / remove, sensitive leave hidden from managers, audit |
| `schedules.e2e-spec.ts` | department vs personal schedules in force, ending / deleting assignments, multi-day holidays, holiday edits, holidays not required |
| `leave-entitlements.e2e-spec.ts` | personal yearly entitlements for a group, ledger correction of an open year, hiring-year proration kept, back to default, future years, HR only |
| `overtime-direct.e2e-spec.ts` | days with extra time in scope, direct approval capped at the recorded time, pending request approved instead, no self-approval, report counts approved overtime only |
| `overtime.e2e-spec.ts` | retrospective cap at calc.ts extra minutes, minimum, duplicates, pre-approval, weekend multiplier, policy edits and snapshots, scope |
| `corrections.e2e-spec.ts` | missing check-out / check-in, wrong time; appended ADMIN_CORRECTION events, untouched originals, re-validation on approval, scope |
| `corrections-direct.e2e-spec.ts` | HR direct corrections: attendance.correct only (manager / employee 403, no self-correction), each kind, overlap and invalid-time refusals, required reason, audit rows, untouched original events, history and Approval Center |
| `approvals.e2e-spec.ts` | Approval Center scope per role, tabs, filters, paging, bulk approve with per-item results, notifications, audit |
| `portal-visibility.e2e-spec.ts` | employee-portal visibility setting: all 14 keys visible by default, hidden pages / sections block new requests (403 `PORTAL_DISABLED`) while reads and balances keep working, locked and unknown keys rejected, `settings.manage` only, audited |
| `employee-hub.e2e-spec.ts` | one employee's requests of every kind, overtime candidates for one employee, leave ledger history with reason and author, scope refusals |
| `api-gaps.e2e-spec.ts` | today's public holiday and approved leave on `/attendance/me/status`, department Arabic names on the dashboard, Arabic-folding employee and live-attendance search |
| others | password hashing, audit hashing, app configuration, static web serving |

## Repository layout

```
apps/api        NestJS API (+ serves apps/web/out)       apps/web     Next.js app
packages/shared API contract (types, permissions, codes)  deploy/      Docker Compose, Caddy, backups
docs/           architecture, security, deployment        dev/         local PostgreSQL launcher
legacy/         first prototype, kept for reference
```

## Features

- Login with roles (Super Admin, HR, department manager, employee); managers only see their departments.
- Check-in, check-out and breaks; check-in and check-out only within the office area (device location); remote-work days can check in from home.
- Fixed and flexible schedules, core hours, overnight shifts, included breaks and public holidays.
- Leave with yearly or monthly entitlements, carry-over, personal entitlements and supporting documents.
- Overtime requests and direct approval, attendance corrections, and one approval center for all of them.
- Admin dashboard, live attendance, employee pages, reports with Excel and CSV export.
- Notifications, audit log, light and dark theme, Arabic and English, Ctrl+K search.
- Nouria, a talking mascot managed under Settings -> Nouria.

Not done yet: monthly timesheet closing, PDF export, a roles editor, browser end-to-end tests, and
running the Docker/HTTPS setup on the real server. See `docs/security.md` for known gaps.
