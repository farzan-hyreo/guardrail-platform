---
name: runbook
description: Use when starting the stack, running migrations, checking whether a service is alive, tracing a request across the bus, or diagnosing a failure at runtime. Contains every command needed to run and debug the platform locally.
---

# Runbook

Covers: setting up (12:22), staying in control (2:50:11).

## First run

```bash
pnpm install
cp .env.example .env            # fill BETTER_AUTH_SECRET and ENVELOPE_SECRET
make up                         # NATS + Postgres, then creates the streams
make migrate                    # every service's migrations
make dev                        # gateway + all four services
```

`ENVELOPE_SECRET` must be identical for the gateway and every service, or services reject
every request with `UNTRUSTED_ENVELOPE`.

## Daily

| Command | Does |
| --- | --- |
| `make dev` | everything |
| `make web` | gateway + UI only |
| `make services` | workers only |
| `make logs` | tail every event crossing the bus |
| `make streams` | stream and consumer health |
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

```bash
nats sub 'evt.>'                                  # watch it land
psql $DATABASE_URL -c "select * from audit_log where request_id = '<id>'"
```

## Symptoms

| Symptom | First check |
| --- | --- |
| Every call is `SERVICE_UNAVAILABLE` | is the owning service running? `make streams` |
| `UNTRUSTED_ENVELOPE` | `ENVELOPE_SECRET` mismatch between processes |
| `NO_ACTIVE_ORG` | the user has no membership - `/onboarding` |
| Everyone is on the free plan | `AUTUMN_SECRET_KEY` unset; the adapter degrades by design |
| Rate limits never fire locally | off by default; `RATE_LIMIT_DEV=on` |
| Streams missing after a reset | `pnpm nats:bootstrap` |
| A page 404s that the nav shows | route exists in the registry but not in `app/` |

## Staying in control

- One branch per feature, even for an iteration of the same feature. Seeing the file list
  a change touched is how you keep confidence in code you did not type.
- Run `pnpm verify` before handing anything back. `make fix` first if it is noisy.
- Do not run git commands as part of a task. No commits, branches, resets, or history
  reading - a model that undoes work it thinks it owns can lose a day.
