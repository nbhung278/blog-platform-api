#!/usr/bin/env bash
# Bootstrap script for a fresh EC2 instance (Amazon Linux 2023, ARM64).
# Run as: bash setup-ec2.sh
set -euo pipefail

echo "[1/6] Updating system packages..."
sudo dnf update -y

echo "[2/6] Installing Docker + git..."
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

echo "[3/6] Installing Docker Compose plugin..."
DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
mkdir -p $DOCKER_CONFIG/cli-plugins
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) COMPOSE_ARCH="aarch64"; BUILDX_ARCH="arm64" ;;
  x86_64)  COMPOSE_ARCH="x86_64";  BUILDX_ARCH="amd64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}" \
  -o $DOCKER_CONFIG/cli-plugins/docker-compose
chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose

curl -SL "https://github.com/docker/buildx/releases/latest/download/buildx-v0.20.0.linux-${BUILDX_ARCH}" \
  -o $DOCKER_CONFIG/cli-plugins/docker-buildx
chmod +x $DOCKER_CONFIG/cli-plugins/docker-buildx

echo "[4/6] Installing AWS CLI v2 (for S3 backups)..."
ARCH_AWS=$([ "$ARCH" = "aarch64" ] && echo "aarch64" || echo "x86_64")
curl "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH_AWS}.zip" -o /tmp/awscliv2.zip
sudo dnf install -y unzip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update
rm -rf /tmp/awscliv2.zip /tmp/aws

echo "[5/7] Enabling 1GB swap (OOM safety on small instances)..."
if [ ! -f /swapfile ]; then
  sudo dd if=/dev/zero of=/swapfile bs=1M count=1024 status=progress
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  fi
  sudo sysctl vm.swappiness=10
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
fi

echo "[6/7] Creating app directory..."
APP_DIR=/opt/blog-platform-backend
if [ ! -d "$APP_DIR" ]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown ec2-user:ec2-user "$APP_DIR"
  echo "  -> Empty dir created at $APP_DIR"
  echo "  -> Upload your code there (rsync / git clone) before running step 6."
fi

echo "[7/7] Done. Next steps:"
cat <<'EOF'

  1. Re-login (or run: newgrp docker) so docker group takes effect.
  2. Upload code to /opt/blog-platform-backend (rsync from your machine
     or git clone if repo is on GitHub).
  3. Create /opt/blog-platform-backend/.env from .env.production.example
     and fill in real values.
  4. cd /opt/blog-platform-backend
     docker compose -f docker-compose.prod.yml up -d postgres redis
     # wait ~10s for postgres healthcheck
     docker compose -f docker-compose.prod.yml up -d --build backend
  5. Run migrations + seed:
     docker compose -f docker-compose.prod.yml exec backend bunx prisma migrate deploy
     docker compose -f docker-compose.prod.yml exec backend bun run db:seed
  6. Test: curl http://localhost:3000/  -> {"status":"ok"}
  7. Configure Cloudflare DNS to point api.strix-blog.uk -> this EC2 EIP.

EOF
