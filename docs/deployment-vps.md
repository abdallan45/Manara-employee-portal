# Deployment on a public VPS (portal.manaralab.tech)

Same containers as the on-premise setup (`docs/deployment.md`): PostgreSQL, the app, Caddy and the
backup job. Differences on a VPS:

- Caddy uses `deploy/caddy/Caddyfile.public` and gets a free **Let's Encrypt** certificate for the
  domain by itself, and renews it. No certificate needs installing on phones.
- Caddy listens on all addresses (`LAN_BIND_IP=0.0.0.0`); the firewall allows only SSH, 80 and 443.
- Attendance is checked by **device location** (office geofences), which works from anywhere, so
  the company's internet line does not need a static IP.

Tested parts: the app and its tests run locally. The Compose files and these scripts have not yet
been run on a server; check each step's output.

## 1. DNS

In the DNS panel of `manaralab.tech` (Hostinger: **Domains -> DNS / Nameservers**), add:

| Type | Name | Points to | TTL |
| --- | --- | --- | --- |
| A | `portal` | the VPS IPv4 address (Hostinger VPS panel -> Overview) | 300 |

Check from any computer: `nslookup portal.manaralab.tech` must return the VPS address.

## 2. Server (once)

Recommended: Ubuntu 24.04, at least 2 vCPU / 4 GB RAM (KVM 2). In the Hostinger panel, if its
own firewall is enabled, allow TCP 22, 80, 443 and UDP 443.

From Windows, pack and upload the release (PowerShell, in the repo):

```powershell
powershell -File deploy\vps\make-release.ps1
scp ..\manara-release.tar.gz root@<VPS-IP>:/opt/
```

On the server (`ssh root@<VPS-IP>`):

```sh
mkdir -p /opt/manara/app
tar -xzf /opt/manara-release.tar.gz -C /opt/manara/app
bash /opt/manara/app/deploy/vps/setup-server.sh
```

`setup-server.sh` installs Docker from Docker's repository, enables the firewall (SSH, 80, 443),
adds swap on servers with less than ~3.5 GB RAM, turns on automatic security updates and sets the
time zone to Asia/Amman.

## 3. Start

```sh
cd /opt/manara/app
bash deploy/vps/deploy.sh portal.manaralab.tech <your email>
```

The first run:

1. writes `deploy/.env` with new random database passwords, audit key and backup passphrase
   (`chmod 600`). **Copy `AUDIT_HMAC_KEY` and `BACKUP_PASSPHRASE` into the company password safe.**
2. stops if the domain does not point at this server yet (Let's Encrypt would refuse it);
3. builds the images (several minutes) and starts everything;
4. creates the reference data and the `admin` account with a temporary password, printed once
   and saved in `/opt/manara/admin-initial-password.txt`, and loads Nouria's lines.

Open `https://portal.manaralab.tech`. The first visit can take up to a minute while the
certificate is issued.

## 4. First sign-in

1. Sign in as `admin` with the temporary password; the portal asks for a new one. Then delete
   `/opt/manara/admin-initial-password.txt`.
2. **Settings -> Office locations**: edit "Amman HQ" (or add the office). On a phone **inside the
   office**, press "Use this device's current location", or paste the coordinates from Google
   Maps. Set the radius (150 m is a good start) and make it active. Until an office has
   coordinates, every check-in is refused with "no office location is set up".
3. Choose the mode: block check-in away from the office, or allow it and flag it for review. A week
   in flag mode first shows how precise employees' phones are inside the building.
4. Add departments, schedules and employees.

Demo accounts and one-click login are off in production (`DEMO_MODE=false`, no demo seed).

## 5. Updating

```powershell
powershell -File deploy\vps\make-release.ps1
scp ..\manara-release.tar.gz root@<VPS-IP>:/opt/
```

```sh
cd /opt/manara/app
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /backup.sh --once   # manual backup first
tar -xzf /opt/manara-release.tar.gz -C /opt/manara/app   # keeps deploy/.env (not in the release)
bash deploy/vps/deploy.sh portal.manaralab.tech <your email>
```

Migrations run automatically when the app container starts.

## 6. Backups

Nightly encrypted dumps go to `/opt/manara/backups` (30 days). They are on the same server:
copy them elsewhere regularly, for example from Windows:

```powershell
scp -r root@<VPS-IP>:/opt/manara/backups D:\manara-backups
```

Restoring is described in `docs/deployment.md`, "Restore from backup".

## 7. Security notes for a public server

- Everyone on the internet can reach the sign-in page. Login lockout and rate limits apply; use
  long passwords for admin and HR accounts.
- Use SSH keys for the server and disable password login for root
  (`PasswordAuthentication no` in `/etc/ssh/sshd_config`) once a key works.
- The database and the app are not published; only Caddy is.
- Device location can be faked by a determined user (see `docs/security.md`); review refused and
  flagged check-ins in the audit log.

## Useful commands

```sh
cd /opt/manara/app
C="docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$C ps                    # status
$C logs -f app           # app logs
$C logs caddy            # certificate problems show here
$C restart app
```
