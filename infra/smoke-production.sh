#!/usr/bin/env bash
# Isolated CI only: never point this at a real database or Telegram token.
set -euo pipefail
: "${DATABASE_URL:?Set isolated *_test database}"
if [[ "${DATABASE_URL##*/}" != *_test ]]; then
  echo 'Production smoke requires a dedicated *_test database.' >&2
  exit 1
fi
image="${SMOKE_IMAGE:-luchok:ci}"
name="luchok-ci-smoke-${RANDOM}"
export NODE_ENV=production APP_MODE=production HOST=0.0.0.0 PORT=3000
export APP_ORIGIN=https://ci.invalid BOT_DELIVERY_MODE=live
export DATA_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export BOT_TOKEN=123456:synthetic-ci-token-never-connect-telegram
export WEBHOOK_SECRET=synthetic-ci-webhook-secret-at-least-32-characters
export MEDIA_DIR=/data/media
args=(--network host --env DATABASE_URL --env NODE_ENV --env APP_MODE --env HOST --env PORT --env APP_ORIGIN --env BOT_DELIVERY_MODE --env DATA_KEY --env BOT_TOKEN --env WEBHOOK_SECRET --env MEDIA_DIR)
cleanup(){ docker rm -f "$name" "${name}-worker" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Caller supplies an empty isolated database. No public exposure, webhook or bot API calls.
docker run --rm "${args[@]}" "$image" node dist-server/server/migrate.js
docker run -d --name "$name" "${args[@]}" "$image" >/dev/null
for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/health/ready >/dev/null; then break; fi
  if [[ "$attempt" == 30 ]]; then docker logs "$name"; exit 1; fi
  sleep 1
done
code=$(curl -sS -o /tmp/luchok-dev-login.json -w '%{http_code}' -X POST -H 'Origin: https://ci.invalid' -H 'Content-Type: application/json' -d '{"role":"OWNER"}' http://127.0.0.1:3000/api/auth/dev)
[[ "$code" == 404 ]] || { echo "Production dev auth returned $code"; exit 1; }
curl -fsS http://127.0.0.1:3000/api/settings | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.acceptingOrders||Object.values(x.carriers).some(c=>c.enabled))process.exit(1);'
# Worker has a fresh database with no recipients/outbox; it cannot send test messages.
docker run -d --name "${name}-worker" "${args[@]}" "$image" node dist-server/server/worker.js >/dev/null
for attempt in {1..30}; do
  if docker exec "${name}-worker" node --input-type=module -e 'import pg from "pg";const p=new pg.Pool({connectionString:process.env.DATABASE_URL});p.query("SELECT 1 FROM jobs WHERE name=$1 AND last_run_at>now()-interval '\''120 seconds'\''",["maintenance"]).then(r=>{if(r.rowCount!==1)process.exitCode=1}).finally(()=>p.end());'; then break; fi
  if [[ "$attempt" == 30 ]]; then docker logs "${name}-worker"; exit 1; fi
  sleep 1
done
echo 'PASS production image: migrations, API ready, dev auth absent, ordering closed, worker heartbeat'
