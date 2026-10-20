#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu/Debian VPS (run as root):
#   Docker Engine + Compose plugin, git, firewall (SSH, HTTP, HTTPS only), swap on small servers,
#   automatic security updates, a read-only GitHub deploy key, and the code in /opt/manara/app.
# The repository is private, so this file is copied to the server on its own first:
#   scp deploy/vps/setup-server.sh root@<VPS-IP>:/root/
#   ssh root@<VPS-IP> bash /root/setup-server.sh
set -euo pipefail

REPO="${REPO:-abdallan45/Manara-employee-portal}"
APP_DIR=/opt/manara/app
KEY=/root/.ssh/manara_deploy

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash $0)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git openssl ufw unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker Engine (official repository)..."
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker compose version

# Firewall: only SSH and the web ports. The database and the app are never published.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
ufw status verbose

# Building the images needs about 3 GB of memory; add swap on smaller servers.
mem_mb=$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)
if [ "$mem_mb" -lt 3500 ] && ! swapon --show | grep -q .; then
  echo "Adding a 2 GB swap file (RAM: ${mem_mb} MB)..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone Asia/Amman || true
mkdir -p /opt/manara/backups

# Read-only access to the private repository: a deploy key that belongs to this server only.
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N '' -C "manara-vps-deploy" -f "$KEY" >/dev/null
fi
# GitHub's published host key (docs.github.com, "GitHub's SSH key fingerprints"), so the first
# connection cannot be intercepted.
grep -q '^github.com ssh-ed25519 ' /root/.ssh/known_hosts 2>/dev/null \
  || echo 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' >> /root/.ssh/known_hosts
if ! grep -q '^Host github-manara$' /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<EOF
Host github-manara
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 /root/.ssh/config
fi

until GIT_SSH_COMMAND='ssh -o BatchMode=yes' git ls-remote "git@github-manara:${REPO}.git" >/dev/null 2>&1; do
  echo
  echo "Add this key to GitHub: https://github.com/${REPO}/settings/keys -> Add deploy key"
  echo "(title: manara-vps, leave \"Allow write access\" OFF)"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Press Enter after adding it... "
done

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "git@github-manara:${REPO}.git" "$APP_DIR"
fi

echo
echo "Server ready, code in $APP_DIR. Next:"
echo "  bash $APP_DIR/deploy/vps/deploy.sh portal.manaralab.tech you@example.com"
