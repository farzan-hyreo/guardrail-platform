---
name: runbook
description: Use when starting the stack, running migrations, checking whether a service is alive, tracing a request across the bus, or diagnosing a failure at runtime. Contains every command needed to run and debug the platform locally.
---

# Runbook

Covers: setting up (12:22), staying in control (2:50:11).

## First run

NATS authenticates every connection - no anonymous fallback. Development keys are already
checked in under `infra/nats/creds/`; full detail is `infra/nats/RUNBOOK.md`.

```bash
pnpm install
cp .env.example .env                                    # fill BETTER_AUTH_SECRET and ENVELOPE_SECRET
cp infra/nats/creds/gateway.env apps/web/.env.local      # one-time - Next has no --env-file flag
set -a; . infra/nats/creds/bootstrap.env; set +a
make up                         # NATS + Postgres, then creates the streams
make migrate                    # every service's migrations
make dev                        # gateway + all four services
```

`ENVELOPE_SECRET` must be identical for the gateway and every service, or services reject
every request with `UNTRUSTED_ENVELOPE`. That is a separate secret from the NATS
credentials above: `ENVELOPE_SECRET` proves who authorised a request; the NATS credential
proves which process is even allowed to publish or subscribe. The four services already
carry their own NATS credential via `--env-file` in each `package.json`'s `dev` script -
only the gateway needed the manual copy above.

## Daily

| Command | Does |
| --- | --- |
| `make dev` | everything |
| `make web` | gateway + UI only |
| `make services` | workers only |
| `make logs` | tail every event crossing the bus - needs `observer.env` exported first (below) |
| `make streams` | stream and consumer health - needs a NATS credential too; `observer.env` does not cover it (JetStream API subjects aren't in its permissions) and no documented credential currently does - see `jetstream-service` |
| `make subjects` | every subject the registry generates |
| `make verify` | typecheck + Biome + architecture check |
| `make fix` | format, autofix, repair violations |
| `make reset` | wipe local NATS and Postgres data |

One service at a time:
`pnpm --filter @guardrail/service-projects dev`

## Migrations

Each service owns its own. Never migrate another service's tables.

```bash
pnpm --filter @guardrail/service-projects db:generate
pnpm --filter @guardrail/service-projects db:migrate
pnpm auth:generate     # after changing Better Auth plugins, then diff the schema
```

## Tracing one request

Every request carries `x-request-id` from `proxy.ts` through the envelope to the audit row.
`nats sub` needs a credential too - `observer` is development-only and read-only on `evt.>`:

```bash
set -a; . infra/nats/creds/observer.env; set +a
nats sub 'evt.>'                                  # watch it land
psql $DATABASE_URL -c "select * from audit_log where request_id = '<id>'"
```

## Symptoms

| Symptom | First check |
| --- | --- |
| Every call is `SERVICE_UNAVAILABLE` | is the owning service running? Check its process/log directly - `make streams` needs a NATS credential no documented user currently has, see the Daily table above |
| NATS log: `authentication error - Nkey ""` | that process sent no NATS credential - see First run above, or `infra/nats/RUNBOOK.md` |
| NATS log: `Authorization Violation` | wrong NATS credential for that identity, or `auth.conf` is stale - `infra/nats/RUNBOOK.md` |
| `UNTRUSTED_ENVELOPE` | `ENVELOPE_SECRET` mismatch between processes |
| `NO_ACTIVE_ORG` | the user has no membership - `/onboarding` |
| Everyone is on the free plan | `AUTUMN_SECRET_KEY` unset; the adapter degrades by design |
| Rate limits never fire locally | off by default; `RATE_LIMIT_DEV=on` |
| Streams missing after a reset | `set -a; . infra/nats/creds/bootstrap.env; set +a; pnpm nats:bootstrap` |
| A page 404s that the nav shows | route exists in the registry but not in `app/` |

## Staying in control

- One branch per feature, even for an iteration of the same feature. Seeing the file list
  a change touched is how you keep confidence in code you did not type.
- Run `pnpm verify` before handing anything back. `make fix` first if it is noisy.
- Do not run git commands as part of a task. No commits, branches, resets, or history
  reading - a model that undoes work it thinks it owns can lose a day.
