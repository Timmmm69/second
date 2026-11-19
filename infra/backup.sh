#!/usr/bin/env bash
# Run as root on the Linux Docker host; only the PUBLIC age recipient lives here.
set -Eeuo pipefail
umask 077

[[ $EUID -eq 0 ]] || { echo 'Run as root on the Docker host' >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
destination=${1:-/var/backups/luchok}
recipients=${2:-/etc/luchok-backup-recipients.txt}
for executable in docker age flock tar sha256sum du df realpath; do
  command -v "$executable" >/dev/null
done
[[ -s "$recipients" && -s "$root/infra/.env" ]] || {
  echo 'Missing public recipients or production env file' >&2; exit 1;
}
install -d -m 700 -- "$destination"
destination=$(realpath -- "$destination")
[[ "$destination" != / && "$destination" != "$root" ]] || exit 1
exec 9>"$destination/.lock"
flock -n 9 || { echo 'A backup is already running' >&2; exit 1; }
compose=(docker compose --env-file "$root/infra/.env" -f "$root/infra/compose.yaml")
running=$("${compose[@]}" ps --status running --services)
for service in db api worker; do
  grep -qx "$service" <<<"$running" || { echo "Service is not running: $service" >&2; exit 1; }
done
api_id=$("${compose[@]}" ps -q api)
media=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/media"}}{{.Source}}{{end}}{{end}}' "$api_id")
[[ -n "$media" && -d "$media" ]] || { echo 'Media volume is missing' >&2; exit 1; }
# Keep at least 1 GiB free, even while writing another full encrypted snapshot.
media_bytes=$(du -sb -- "$media" | cut -f1)
database_bytes=$("${compose[@]}" exec -T db psql -U veshi -d veshi -Atc 'SELECT pg_database_size(current_database())')
available=$(df --output=avail -B1 "$destination" | tail -1 | tr -d ' ')
[[ "$database_bytes" =~ ^[0-9]+$ && "$available" =~ ^[0-9]+$ ]] || exit 1
(( available > media_bytes + database_bytes * 2 + 1073741824 )) || {
  echo 'Insufficient space for a new backup plus 1 GiB reserve' >&2; exit 1;
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage=$(mktemp -d "$destination/.partial.XXXXXXXX")
resume=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( resume )); then
    "${compose[@]}" start --wait --wait-timeout 120 api worker || status=1
  fi
  [[ ! -d "$stage" ]] || rm -rf -- "$stage"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Quiesce both writers so DB references and photo bytes describe the same state.
# Caddy remains up; the short maintenance interval returns an unavailable response.
resume=1
"${compose[@]}" stop -t 45 api worker
"${compose[@]}" exec -T db pg_dump -U veshi -d veshi -Fc --no-owner --no-acl |
  age -R "$recipients" -o "$stage/database.dump.age"
tar -C "$media" -cf - . | age -R "$recipients" -o "$stage/media.tar.age"
tar -C "$root" -cf - infra/.env infra/compose.yaml infra/Caddyfile |
  age -R "$recipients" -o "$stage/configuration.tar.age"
docker inspect --format '{{.Image}}' "$api_id" > "$stage/image-id.txt"
(cd "$stage" && sha256sum ./*.age image-id.txt > SHA256SUMS)
"${compose[@]}" start --wait --wait-timeout 120 api worker
resume=0
mv -T -- "$stage" "$destination/$stamp"
# Prune only complete snapshots created by this script, after a successful backup.
mapfile -t snapshots < <(find "$destination" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
  grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r)
for (( index=2; index<${#snapshots[@]}; index++ )); do
  [[ -f "$destination/${snapshots[index]}/SHA256SUMS" ]] || continue
  rm -rf -- "$destination/${snapshots[index]}"
done
echo "Encrypted backup complete: $destination/$stamp"
