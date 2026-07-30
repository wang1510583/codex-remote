#!/bin/sh
set -eu

service_name="${1:-codex-remote.service}"
base_url="${2:-http://127.0.0.1:5567/codexremote}"
project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
service_user="${CODEX_REMOTE_SERVICE_USER:-wangjiafeng}"
service_home="${CODEX_REMOTE_SERVICE_HOME:-/home/wangjiafeng}"

systemctl restart "$service_name"

attempt=0
until curl --fail --silent --show-error --output /dev/null \
  --max-time 2 "${base_url%/}/login"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    echo "Codex Remote did not become reachable after restart." >&2
    exit 1
  fi
  sleep 1
done

runuser -u "$service_user" -- env HOME="$service_home" \
  /usr/bin/node "$project_dir/scripts/verify-live-voice.mjs" "$base_url"
runuser -u "$service_user" -- env HOME="$service_home" \
  "$service_home/.local/bin/codex" app-server daemon version
systemctl is-active --quiet "$service_name"
echo "Codex Remote restart and verification completed."
