#!/usr/bin/env bash
# Stage first. Optional cutover: ./deploy/install-nas.sh OLD_CONTAINER OLD_HOST_PORT NAS_BIND_IP
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
docker info >/dev/null
docker build -t zhilan-coread:local .
if [ ! -f .env ]; then
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work --entrypoint node zhilan-coread:local scripts/setup.mjs
fi
chmod 600 .env
mkdir -p data
chmod 700 data
docker compose up -d --no-build
container="$(docker compose ps -q coread)"
check_internal() {
  for attempt in $(seq 1 30); do
    if docker exec "$container" node -e "Promise.all([fetch('http://127.0.0.1:3000/healthz'),fetch('http://127.0.0.1:3000/v1/books'),fetch('http://127.0.0.1:3000/mcp')]).then(r=>process.exit(r[0].ok&&r[1].status===401&&r[2].status===401?0:1)).catch(()=>process.exit(1))"; then return 0; fi
    sleep 2
  done
  return 1
}
check_internal
echo 'Staging healthy; anonymous API and MCP denied. Old service has not been changed.'
if [ "$#" -eq 0 ]; then exit 0; fi
if [ "$#" -ne 3 ]; then echo 'Usage: install-nas.sh [OLD_CONTAINER OLD_HOST_PORT NAS_BIND_IP]' >&2; exit 1; fi
old="$1"; port="$2"; bind="$3"
case "$port" in ''|*[!0-9]*) echo 'Invalid port' >&2; exit 1;; esac
if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then echo 'Invalid port' >&2; exit 1; fi
if ! printf '%s' "$bind" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then echo 'An explicit NAS IPv4 bind address is required' >&2; exit 1; fi
docker inspect "$old" --format '{{.Name}} {{json .NetworkSettings.Ports}}'
if ! docker port "$old" | grep -Eq ":${port}$"; then echo 'Requested port is not published by the old container; no cutover performed.' >&2; exit 1; fi
mkdir -p .deploy-state
docker inspect "$old" --format '{{json .Mounts}}' > .deploy-state/old-mounts.json
cp -p .env .deploy-state/before-cutover.env
was_running="$(docker inspect "$old" --format '{{.State.Running}}')"
cutover=0
rollback() {
  if [ "$cutover" = 1 ]; then
    docker compose down || true
    cp -p .deploy-state/before-cutover.env .env
    if [ "$was_running" = true ]; then docker start "$old"; fi
    echo 'Cutover failed; previous container state restored. All volumes retained.' >&2
  fi
}
trap rollback ERR
cutover=1
docker stop "$old"
docker compose down
sed -i "s/^COREAD_HOST_PORT=.*/COREAD_HOST_PORT=$port/;s/^COREAD_BIND_IP=.*/COREAD_BIND_IP=$bind/" .env
docker compose up -d --no-build
container="$(docker compose ps -q coread)"
check_internal
curl --fail --silent --show-error --max-time 20 https://reading.ddnsto.com/healthz | grep -F '"service":"zhilan-coread"' >/dev/null
curl --fail --silent --show-error --max-time 20 https://reading.ddnsto.com/.well-known/oauth-protected-resource/mcp | grep -F '"resource":"https://reading.ddnsto.com/mcp"' >/dev/null
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 https://reading.ddnsto.com/mcp)"
test "$status" = 401
cutover=0
trap - ERR
echo 'Cutover complete. DDNSTO unchanged. Web: https://reading.ddnsto.com/ ; MCP: https://reading.ddnsto.com/mcp'
echo 'The old container and all its mounts are retained; no legacy data has been imported or deleted.'
