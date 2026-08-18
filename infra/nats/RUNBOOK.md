# SOT: nats-auth-runbook, bus-credentials, nats-permissions-runbook

**WHAT** How to run, change and deploy a bus that authenticates.
**WHY** NATS used to start with `--jetstream` and nothing else — no accounts, no users, no
permissions. Every finding in the review that began "an attacker with NATS credentials"
actually read "anything that can reach :4222", because there were no credentials to have.
**HOW** `nats.conf` holds what the registry has no opinion about; `auth.conf` holds who may
do what and is generated from `packages/registry/src/registry.ts`.
**WHERE** `infra/docker-compose.yml`, `infra/nats/*`, `Makefile`.

---

## Read this first: the client change has landed

Both halves are done and tested: the server side, and the **client** side that used to live
outside this directory while another agent had it open -

- `packages/env/src/index.ts` — `natsUser()` and `natsNkeySeed()`
- `packages/transport/src/connection.ts` — passed to `connect()` as `name`, `inboxPrefix`
  and `authenticator`

[`client-auth.patch`](./client-auth.patch) is the historical record of that change, not a
step left to do. See [The client change](#the-client-change) below for what actually shipped.

There is deliberately **no anonymous fallback and no `no_auth_user`**. An escape hatch that
makes the stack work without credentials is the state we were trying to leave. If `make up`
still logs `authentication error - Nkey ""`, the cause is a missing credential in *your*
environment (see [What a developer does](#what-a-developer-does) and
[When something will not connect](#when-something-will-not-connect)), not a missing patch.

---

## What a developer does

`make up` runs `pnpm nats:bootstrap`, and that step authenticates like everything else -
export its credential first, or it fails with the same `Nkey ""` error as any other
unauthenticated process:

```bash
set -a; . infra/nats/creds/bootstrap.env; set +a
make up            # docker compose up + pnpm nats:bootstrap
make dev           # gateway and services - each needs its own credential, below
```

`infra/nats/creds/` already contains a working set of development keys, checked in on
purpose — the same posture as `POSTGRES_PASSWORD: guardrail` two lines above it in the
compose file. They are worth exactly as much as any other value in a public repository.
**A deployment generates its own** (see [Deploying](#deploying)).

Each process needs the credential for its own identity. One env file per user is written
next to the seeds:

```bash
cat infra/nats/creds/identity.env
# NATS_USER=identity
# NATS_NKEY_SEED=SUA...
```

Three ways to get it into the process, from most to least convenient:

**One line per service `package.json`** — already done for all four services (Node 20+ and
`tsx` both understand `--env-file`; `--env-file` must come *after* `watch`, not before it:
`tsx`'s own CLI only recognises `watch` as a subcommand when it is the first argument, so
`tsx --env-file=... watch ...` silently tries to run a script named `watch` instead
(`ERR_MODULE_NOT_FOUND`) — verified against the installed `tsx@4.23.12`):

```jsonc
"dev": "tsx watch --env-file=../../infra/nats/creds/identity.env src/index.ts",
```

The gateway is different, and still needs a one-time manual step: `next dev` has its own
CLI with no `--env-file` flag, but Next.js already auto-loads `apps/web/.env.local`
(gitignored, same as this repo's root `.env`) into the process with no flag needed. Copy
`infra/nats/creds/gateway.env`'s two lines into `apps/web/.env.local` once, and the gateway
is covered by the same "one line, not a launcher" approach the services already have. After
that, plain `pnpm dev` / `make dev` is least-privileged for all five processes and nobody
has to remember anything.

**A launcher, if you'd rather not do the one-time gateway copy:**

```bash
./infra/nats/dev.sh                      # every service, each with its own credential
./infra/nats/dev.sh identity             # just one
```

**By hand:**

```bash
set -a; . infra/nats/creds/identity.env; set +a
pnpm --filter @guardrail/service-identity dev
```

`pnpm nats:bootstrap` needs `bootstrap.env`; `make logs` needs `observer.env`. `make up`
runs the bootstrap step, so export that one before it:

```bash
set -a; . infra/nats/creds/bootstrap.env; set +a; make up
```

## Who may do what

Eight identities, in two accounts. Every subject below is computed from the registry — none
of it is typed by hand, so an operation added to `registry.ts` appears here on the next
regenerate and an operation removed disappears.

| User | Publishes | Subscribes | Can it… |
|---|---|---|---|
| `gateway` | every `rpc.*` and `cmd.*` the registry declares | `_INBOX.gateway.>` | **not** answer for a service, **not** emit an event, **not** read `evt.>` |
| `projects` | `evt.project.*` | `rpc.project.*` | **not** publish a command, **not** touch identity's subjects |
| `identity` | `evt.member.*`, `evt.invitation.*`, the CMD consumer API, `$JS.ACK.>` | `rpc.member.*`, `rpc.invitation.*` | **not** publish a command it then consumes, **not** consume `evt.>` |
| `billing` | `evt.billing.manage`, the EVT consumer API, `$JS.ACK.>` | `rpc.billing.*` | **not** meter anything it did not receive, **not** read the CMD stream |
| `audit` | the EVT consumer API, `$JS.ACK.>` | `rpc.auditLog.read` | **not** publish any message at all onto a stream |
| `bootstrap` | `$JS.API.STREAM.{CREATE,UPDATE,INFO}.{CMD,EVT}` | `_INBOX.bootstrap.>` | **not** publish onto the streams it creates |
| `observer` | nothing (`deny: [">"]`) | `evt.>` | development only — events carry `orgId`, `userId` and `role` |
| `sysadmin` | `$SYS` account | | nothing in `APP` |

Two mechanisms carry more weight than they look:

- **`allow_responses: { max: 1, expires: "30s" }`** on the four services. A service may
  answer exactly one message per request it actually received, and only on that request's
  reply subject. It never needs — and never gets — permission to publish into
  `_INBOX.gateway.>` at will, so it cannot inject a reply into a conversation it is not
  part of. This is what makes C4 (unsigned, raceable rpc replies) unreachable rather than
  merely detected: to race the real service you must first be subscribed to the rpc subject,
  and only its owner is.
- **A per-user inbox prefix.** `_INBOX.<user>.>` means a compromised service cannot
  subscribe to the gateway's inbox and read every reply crossing the bus. This is the one
  part of the design that needs the client change: the prefix is chosen by the client.

### What this makes unreachable

| Review finding | Before | After |
|---|---|---|
| C1 payload swap on a captured envelope | any process on the host | requires the gateway's key |
| C4 forged rpc reply, raced against the real service | any process on the host | requires the owning service's key |
| H2 forged `evt.*` metering a victim org | any process on the host | requires a service key, and only for its own resources |
| Command replay onto `cmd.>` | any process on the host | requires the gateway's key |
| Reading every org's events off `evt.>` | any process on the host | `observer` only, and only in development |

None of that is a reason to stop signing envelopes. Authentication answers "which of our
processes is this"; the HMAC answers "did the gateway authorise this org id". A compromised
service still holds a legitimate key — that is why `defineService` verifies the envelope
even for traffic the server let through.

## Changing the registry

Adding an operation, a resource, or a service means the subjects change:

```bash
pnpm exec tsx infra/nats/generate-auth.ts     # rewrite auth.conf; keys are left alone
docker compose -f infra/docker-compose.yml restart nats
node infra/nats/verify.mjs                    # 23 assertions against the running server
```

`--check` is the version for CI. It regenerates in memory and fails if `auth.conf` no longer
matches the registry, which is the failure you want on the pull request that added an
operation and forgot the bus:

```bash
pnpm exec tsx infra/nats/generate-auth.ts --check
```

`verify.mjs` asserts both halves — that every allowed path works *and* that every forbidden
one is refused by the server. The forbidden half is the half no amount of running the app
locally will ever exercise.

## Deploying

1. **Generate this environment's own keys.** Never ship `infra/nats/creds/`.

   ```bash
   pnpm exec tsx infra/nats/generate-auth.ts --rotate --out /secure/tmp/nats
   ```

   `auth.conf` is rewritten with the new public keys. Public keys are not secret: ship that
   file with the server. `/secure/tmp/nats/*.nk` are the private halves.

2. **Put each seed where only its own process can read it.** One secret per identity —
   `guardrail/nats/identity`, `guardrail/nats/gateway`, and so on — injected as
   `NATS_USER` + `NATS_NKEY_SEED` into that container and no other. A single secret shared
   by every service throws away the entire point of the file.

3. **Drop the `observer` user** unless something needs it. Delete its entry from `USERS` in
   `generate-auth.ts` for that environment, or generate with it and revoke. `evt.>` carries
   org and user identifiers for every mutation in the platform.

4. **Terminate TLS.** Nothing above encrypts anything. Add to `nats.conf`:

   ```
   tls {
     cert_file: "/etc/nats/certs/server.pem"
     key_file:  "/etc/nats/certs/server-key.pem"
     verify: true            # and mutual TLS if the clients can carry certificates
   }
   ```

5. **Rotate by adding, then removing.** nkeys are per-user, so a rotation is: generate the
   new key, add a *second* user entry with the same permissions, restart the server, move
   the process to the new seed, delete the old entry. No window where the bus is open.

### If you outgrow one account

Today `APP` is one account holding eight users. The next step up is an account per service
with explicit `exports`/`imports` for each rpc subject and a JetStream domain each. That
buys isolation of the subject *namespace* — a bug in a permission list stops being able to
reach another service at all. It costs an export/import pair per operation, which is a
generator change, not a config change, and it is only worth doing when services stop being
written by the same team. The boundary that matters first — who may publish a command, an
event, or a reply — is already enforced per user.

## The client change

Already applied, verified against both files as they stand today. Kept here as the
reference for what each half does and why - read this before touching either file, since
the comments explain load-bearing decisions (`inboxPrefix`, the production-only throw) that
are easy to "simplify" away.

`packages/env/src/index.ts`, beside `natsUrl`:

```ts
  /** Names the NATS credential this process holds. See infra/nats/auth.conf. */
  natsUser: (): string => optional("NATS_USER") ?? optional("SERVICE_NAME") ?? "gateway",
  /**
   * The private half of that credential. The bus refuses an unauthenticated connection, so
   * a deployment without one fails at boot rather than on a customer's request.
   */
  natsNkeySeed: (): string | null => {
    const seed = optional("NATS_NKEY_SEED");
    if (seed === null && process.env["NODE_ENV"] === "production") {
      throw new Error(
        "Missing NATS_NKEY_SEED. The bus authenticates; see infra/nats/RUNBOOK.md.",
      );
    }
    return seed;
  },
```

`packages/transport/src/connection.ts` — one import and one call:

```ts
import { connect, type NatsConnection, nkeyAuthenticator } from "@nats-io/transport-node";

/**
 * Not `async`: it hands back the one shared promise rather than awaiting and re-wrapping it.
 * The seed is this process's identity on the bus; auth.conf says which subjects that
 * identity may use. `inboxPrefix` scopes replies to this process, so a compromised service
 * cannot subscribe to the gateway's inbox and read every answer crossing the bus.
 */
export function connection(): Promise<NatsConnection> {
  const user = env.natsUser();
  const seed = env.natsNkeySeed();
  globalThis.__guardrailNats ??= connect({
    servers: natsUrl(),
    name: user,
    inboxPrefix: `_INBOX.${user}`,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
    // exactOptionalPropertyTypes: an absent seed is an absent key, never `undefined`.
    ...(seed === null
      ? {}
      : { authenticator: nkeyAuthenticator(new TextEncoder().encode(seed)) }),
  });
  return globalThis.__guardrailNats;
}
```

`nkeyAuthenticator` is re-exported by `@nats-io/transport-node`, which
`packages/transport` already depends on — no `pnpm install`.

`.env.example` already carries `NATS_USER` and `NATS_NKEY_SEED` with a pointer back to this
file - leave both in sync if either changes.

## When something will not connect

| What you see | What it is | Fix |
|---|---|---|
| server log: `authentication error - Nkey ""` | the process sent no credential | `NATS_NKEY_SEED` is not in that process's environment - see [What a developer does](#what-a-developer-does) |
| server log: `Authorization Violation` | wrong seed for that user | the seed does not match any `nkey` in `auth.conf` — regenerate, or you are pointing at a server started from a different `auth.conf` |
| server log: `Publish Violation ... Subject "rpc.x.y"` | a process is publishing something its identity may not | if the subject is legitimate, the registry and `auth.conf` disagree — regenerate |
| server log: `Subscription Violation ... "_INBOX.gateway.>"` | two processes are sharing one identity | each needs its own `NATS_USER`/`NATS_NKEY_SEED` |
| requests time out, no violation logged | the service subscribed but cannot answer | check `allow_responses` survived the last regenerate |
| `make up` hangs on bootstrap | `bootstrap.env` was not exported | `set -a; . infra/nats/creds/bootstrap.env; set +a` |
| everything worked, then stopped after a registry change | `auth.conf` is stale | regenerate and restart the `nats` container |
