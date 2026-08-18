#!/usr/bin/env bash
# SOT: nats-dev-launcher, per-service-credentials
# WHAT   Starts the services, each with its own NATS credential.
# WHY    `pnpm dev` runs every service in one process tree with one environment, so all
#        four would present the same nkey and the per-service permissions in auth.conf
#        would be decoration. This gives each one the identity auth.conf issued it.
# HOW    ./infra/nats/dev.sh            every service
#        ./infra/nats/dev.sh identity   just that one
#        The end state is one `--env-file=` per service package.json - see RUNBOOK.md -
#        after which plain `pnpm dev` is least-privileged and this script is unnecessary.
# WHERE  infra/nats/RUNBOOK.md, infra/nats/creds/
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CREDS="$HERE/creds"

SERVICES=(projects identity billing audit)
if [ $# -gt 0 ]; then SERVICES=("$@"); fi

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

for service in "${SERVICES[@]}"; do
  env_file="$CREDS/$service.env"
  if [ ! -f "$env_file" ]; then
    echo "No credential for '$service'. Run: pnpm exec tsx infra/nats/generate-auth.ts" >&2
    exit 1
  fi
  echo "starting $service as NATS user '$service'"
  (
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
    cd "$ROOT" && pnpm --filter "@guardrail/service-$service" dev
  ) &
  pids+=($!)
done

echo
echo "The gateway needs its own credential too:"
echo "  set -a; . infra/nats/creds/gateway.env; set +a; pnpm dev:web"
echo
wait
