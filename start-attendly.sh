#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop, then run this again."
  exit 1
fi
docker compose up --build -d
cat <<MSG

Attendly is starting.
Open this on this computer:
  http://localhost:4000

Open this on other computers on the same network:
  http://YOUR-COMPUTER-IP:4000

Login:
  admin@attendly.local
  admin123!

To see logs:
  docker compose logs -f app
MSG
