# On-premise deployment

The platform runs on one Linux server inside the company network: PostgreSQL, the app
(NestJS API + static Next.js web app in one container), Caddy for internal HTTPS, and a
backup container (`postgres:16-alpine` plus the `openssl` tool, built from `deploy/backup/`).
No cloud service is needed after the images are built.

## 1. Server preparation

- Linux server with a **static LAN IP** (example `192.168.1.10`), Docker Engine and the
  Docker Compose plugin.
- An internal DNS name for the app (example `attendance.manara.local`) pointing to that IP
  (router/DNS server entry, or hosts files on managed devices).
- Building the images needs internet access once (npm, base images). After that the system
  runs offline. To install on an air-gapped server, build on a connected machine and move the
  image with `docker save` / `docker load`.

## 2. Configure

```sh
cp deploy/.env.example deploy/.env
# edit deploy/.env: every CHANGE_ME value, LAN_BIND_IP, SITE_ADDRESS
openssl rand -hex 24   # one value each for POSTGRES_PASSWORD, APP_DB_PASSWORD, BACKUP_PASSPHRASE
openssl rand -hex 32   # AUDIT_HMAC_KEY
chmod 600 deploy/.env
```

| Variable | Used by | Purpose |
| --- | --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | db, app (migrations only), backup | Schema owner. Runs `prisma migrate deploy` and the backups. |
| `APP_DB_PASSWORD` | db (first start), app | Password of `workforce_app`, the role the API uses at runtime. |
| `AUDIT_HMAC_KEY` | app | Key of the audit hash chain (32+ characters). The Compose file requires it. |
| `AUDIT_HMAC_KEY_PREVIOUS` | app | Only after a key rotation (see "Audit key"). |
| `BACKUP_PASSPHRASE` | backup | Encrypts every dump (16+ characters). |

Use letters and digits for the passwords: they are placed in connection URLs.

Store `AUDIT_HMAC_KEY` and `BACKUP_PASSPHRASE` in the company password safe as well. Without
the passphrase the backups cannot be restored; without the key older audit rows can no
longer be verified.

### Database roles

The API does not connect as the database owner. On the first start (empty `dbdata`
volume) Postgres runs `deploy/db-init/10-app-role.sh`, which creates the login role
`workforce_app`: no superuser, cannot create tables or change the schema, and (through
default privileges) may read and write the application tables. The migration
`20261020120000_audit_hardening` then takes away `UPDATE`, `DELETE` and `TRUNCATE` on
`audit_logs` and `attendance_events` from it, so the running API can only add to them.

The app container gets two URLs: `MIGRATE_DATABASE_URL` (owner) is used only for
`prisma migrate deploy` at start and is removed from the environment before the API
starts; `DATABASE_URL` (`workforce_app`) is what the API uses.

**Existing installation** (the volume was created before this script existed): the init
script does not run again by itself. Add the new variables to `deploy/.env`, then:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d db
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec \
  -e APP_DB_PASSWORD db sh /docker-entrypoint-initdb.d/10-app-role.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The script is safe to run again at any time (it also resets the role's password to
`APP_DB_PASSWORD`). Run it after every restore as well (see "Restore from backup").

### Audit key

With `AUDIT_HMAC_KEY` set, every new audit row is linked with HMAC-SHA256 under that key
(stored as `h1:...`). Rows written before the key was set stay as they are (plain SHA-256)
and still verify; after the first keyed row, a plain row counts as a break. In production
the API logs a warning at start when the key is missing. It refuses to start with a key
shorter than 32 characters or with the `CHANGE_ME` placeholder.

Rotation (only when the key may have leaked): put the old key in `AUDIT_HMAC_KEY_PREVIOUS`,
a new random key in `AUDIT_HMAC_KEY`, and restart the app. New rows use the new key; old
rows verify with the previous one. Keep the previous key for as long as those rows must be
verifiable. A row signed with the old key after rows signed with the new key counts as a
break.

## 3. Start

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f app
```

The app container applies database migrations on every start (`prisma migrate deploy`, as
the owner role) and then starts the API as `workforce_app`.

Create the reference data and first accounts once:

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec \
  -e SEED_DEFAULT_PASSWORD='<temporary password>' app node dist/prisma/seed.js
```

Load Nouria's starting lines and recordings (only fills an empty database; afterwards manage
them on **Settings -> Nouria**):

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec app node dist/prisma/import-mascot.js
```

Change the seeded password immediately after the first login (the admin account is asked to).

## 4. Internal HTTPS

Caddy issues certificates from its own local certificate authority (`tls internal`).
Export the root certificate once and install it as a trusted root on company devices
(MDM / Group Policy / manual install on phones):

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./manara-internal-root.crt
```

Without it, browsers show a certificate warning, and the PWA and service worker will not
install. If the company already runs an internal CA, replace `tls internal` in
`deploy/caddy/Caddyfile` with `tls /path/cert.pem /path/key.pem`.

## 5. Office location and firewall

Attendance is accepted only from devices whose reported position is inside an office set under
**Settings -> Office locations** (latitude, longitude and a radius, default 150 m). Until an
office with coordinates exists, every check-in is refused with "no office location is set up".
To set it: open the settings on a phone inside the office and press "Use this device's current
location", or paste the coordinates from Google Maps (long-press the building, copy the two
numbers). Browsers only give the position over HTTPS, so the site must be served with a valid
certificate.

The location check does not depend on where the server runs, so the server can be on the LAN or
on a VPS. On the LAN:

- Do not port-forward the server to the internet.
- Isolate the guest Wi-Fi from the staff LAN (client isolation / separate VLAN).
- If a VPN is used for remote administration, give VPN clients a separate subnet that is
  **not** in the trusted list, so remote access cannot record attendance.
- Example (ufw, staff subnet `192.168.1.0/24`):
  ```sh
  ufw default deny incoming
  ufw allow from 192.168.1.0/24 to any port 443 proto tcp
  ufw allow from 192.168.1.0/24 to any port 80 proto tcp
  ufw allow from <admin-ip> to any port 22 proto tcp
  ufw enable
  ```

The app only trusts `X-Forwarded-For` from Caddy's fixed container address
(`TRUSTED_PROXIES=172.28.0.10`). Caddy overwrites any client-supplied value, so clients
cannot spoof their IP. If you put another proxy in front, set `TRUSTED_PROXIES` to its
address; never to a client subnet.

## 6. Backups

The `backup` container writes a compressed `pg_dump` every night at `BACKUP_HOUR`
(company time) to `BACKUP_DIR` (default `./backups` next to the repo) and deletes dumps
older than `BACKUP_RETENTION_DAYS`. Copy that folder to a second disk or NAS regularly;
a backup on the same disk does not survive a disk failure.

- Files are created with mode `600` (`umask 077`). Keep `BACKUP_DIR` readable only by root.
- With `BACKUP_PASSPHRASE` set, each dump is encrypted on the way to disk
  (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`) and named
  `workforce-YYYYMMDD-HHMMSS.dump.enc`. Without it the dump is plain (`.dump`) and the log
  says "NOT encrypted". The script stops with an error if the passphrase is set but
  `openssl` is missing, so it never falls back to plain dumps without telling you.
- Next to each dump the script writes `workforce-YYYYMMDD-HHMMSS.anchor.txt` with the
  newest audit row (`audit_seq`, `audit_hash`) and the dump's SHA-256. Anchors are not
  deleted with old dumps.

Manual backup at any time (same naming, encryption and anchor):

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /backup.sh --once
```

### Audit anchors

Someone with database rights could delete the newest audit rows; the rest of the chain
would still verify. The anchors catch this: every anchored row must still exist with the
same hash.

```sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /check-anchors.sh
# against a copy kept off the server (a folder visible inside the container):
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /check-anchors.sh /backups/offsite-anchors
```

It prints `MISSING` (row gone: the chain was cut or rows were deleted) or `CHANGED` (row
rewritten) per anchor and exits non-zero on any problem. Run *Audit logs -> Verify
integrity* as well; it checks every link between the anchors. Copy the anchor files off
the server with the backups - a copy on the server can be edited by the same person.
After a restore to an older backup, newer anchors report `MISSING`; that is expected.

### Restore from backup

```sh
# 1. stop the app so nothing writes during the restore
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop app
# 2a. encrypted dump (.dump.enc): decrypt and restore in one pipe (replace the file name);
#     --clean drops existing objects first
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh -c \
  'openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in /backups/workforce-YYYYMMDD-HHMMSS.dump.enc | pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE"'
# 2b. plain dump (.dump)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup \
  sh -c 'pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE" /backups/workforce-YYYYMMDD-HHMMSS.dump'
# 3. re-apply the runtime role's rights (the restore recreates the tables)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec \
  -e APP_DB_PASSWORD db sh /docker-entrypoint-initdb.d/10-app-role.sh
# 4. start the app again (migrations newer than the backup are re-applied)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env start app
```

To restore on another machine, decrypt first with the same command and `-out workforce.dump`
instead of the pipe, using the passphrase from the password safe. Compare the encrypted
file with `dump_sha256` in its anchor file (`sha256sum`) before restoring.

Test a restore into a scratch database at least once a quarter.

## 7. Updating

```sh
git pull   # or copy the new release
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build app
```

Take a manual backup before every update.

When updating an installation that predates the `workforce_app` role, follow "Existing
installation" under "Database roles" first.

## Status of this guide

The Compose, Caddy and backup files are written to this design but have **not yet been run
on a Linux server** (the development machine has no Docker). Validate them on the target
server before go-live; see the checklist in `docs/security.md`.
