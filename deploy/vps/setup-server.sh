#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu/Debian VPS (run as root):
#   Docker Engine + Compose plugin, firewall (SSH, HTTP, HTTPS only), swap on small servers,
#   automatic security updates, and the /opt/manara folder.
# Usage: sudo bash deploy/vps/setup-server.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo bash $0)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl openssl ufw unattended-upgrades

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
echo
echo "Server ready. Next: unpack the release into /opt/manara/app and run"
echo "  cd /opt/manara/app && sudo bash deploy/vps/deploy.sh portal.manaralab.tech you@example.com"
