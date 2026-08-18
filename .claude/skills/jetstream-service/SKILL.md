---
name: jetstream-service
description: Use when creating a new service, adding a NATS subject, writing a consumer, choosing between rpc and command transport, or debugging a request that hangs, times out, or runs twice. Covers subjects, streams, queue groups, idempotency and retries.
---

# Services and the bus

## Subjects are generated, never typed

```ts
import { rpcSubject, commandSubject, eventSubject } from "@guardrail/registry";
rpcSubject("project", "create")   // "rpc.project.create"
```

A string literal like `"rpc.project.create"` is an ESLint error (`no-raw-subjects`). A typo
in a subject is a request that hangs until it times out, with no compiler to catch it.

**`no-raw-subjects` matches inside comments too.** `tools/guardrail-check.ts`'s backstop
(`RAW_SUBJECT` in `noRawSubjects`) regexes the raw file text for `["'`]` immediately followed
by `rpc.`/`cmd.`/`evt.` and two more segments - it has no idea whether that quote or backtick
opened a string literal or just formatted a code span inside a `//` or `/** */` comment. A
doc comment that writes `` `evt.member.create` `` or `"cmd.member.create"` to explain an
attack or show an example trips the exact same violation as writing it in code, because the
backtick or quote right before the subject is all the regex is checking for. To describe a
literal subject in a comment without tripping it, don't put a quote, apostrophe or backtick
directly against the `rpc`/`cmd`/`evt`: write it bare (`evt.member.create`, no wrapping
marks) or break the run-on with a word (`` `evt` stream's `member.create` event ``, split so
no delimiter sits immediately before `evt.`/`member.create` as one continuous match).

`pnpm subjects` prints every legal subject.

## Choosing a transport

| | `rpc` | `command` |
| --- | --- | --- |
| Caller | waits for the reply | gets `{ accepted: true }` immediately |
| Delivery | at most once | at least once, durable |
| Use for | reads, quick writes | email, PDF, third-party APIs, anything slow or flaky |
| Handler must be | correct | **idempotent** |
| Deadline | enforced (`timeoutMs`, via `checkFreshness`) | not enforced |

Declared in the registry per operation, not decided at the call site.

A command's `timeoutMs` still exists - it sizes the gateway's request budget for the
`{accepted: true}` acknowledgement - but `checkFreshness` never applies `deadlineAt` to a
command's execution. A command is durable on purpose, and JetStream keeps redelivering it
for as long as the stream holds the message, which can outlast any `timeoutMs` you'd write.
What eventually expires an unprocessed command is the stream's max age
(`packages/transport/src/streams.ts`), not the envelope's `deadlineAt`.

## Adding a service

1. Add its name to `SERVICES` in `packages/registry/src/resources.ts`.
2. Point resources at it with `owner: "<name>"`.
3. Copy `services/projects/` - `package.json`, `tsconfig.json`, `drizzle.config.ts`,
   `src/{schema,db,*.service,*.handlers,index}.ts`.
4. `defineService("<name>", handlers, { secret })` takes a flat list built with
   `handlerFor(resource, operation, fn)`, and asserts at boot that you only handle
   resources the registry says you own.
5. The subject list in `index.ts` comes from `runtime.routes` - derived, never listed.

## Consumers must verify, too

`defineService` verifies the envelope before an `rpc`/`command` handler runs, but an
`evt.*` consumer never goes through it - `consume()` in `packages/transport` hands your
callback the raw bytes straight off the subscription. Build every `evt.*` consumer with
`defineConsumer({ secret }, handler)` from `@guardrail/guardrail`, not a bare callback
passed to `consume()`. It parses the envelope, verifies the signature over meta *and*
payload, and confirms the subject the message arrived on matches what the registry says
that operation emits, before your handler sees anything. Skip it and `meta.orgId` is a
claim from whoever published to that subject. NATS itself authenticates now (see
`infra/nats/RUNBOOK.md`) - a stranger off the host cannot publish at all - but that answers
"which of our processes is this", not "did the gateway authorise this org id". A service
that gets compromised still holds a legitimate key, so it can still publish a well-formed,
unsigned `evt.*` message and forge an event on a victim org, or (since
`audit_log.requestId` is unique with `onConflictDoNothing`) silently suppress a genuine
audit row by racing it with a forged one carrying the same id. `defineConsumer` is what
still catches that. `services/audit` and `services/billing` both build their `evt.>`
consumer this way - copy one, don't write a `consume()` callback from scratch.

## Consumers must be idempotent

At-least-once means the same message will occasionally arrive twice. Make replay harmless
rather than trying to prevent it:

- Unique column plus `onConflictDoNothing` (see `services/audit`).
- Check-then-skip on a natural key (see `identity` invitations).
- Never "increment a counter" in a consumer without a dedupe key.

Commands are published with `msgID: requestId`, so a *retried publish* is deduped by the
server inside the stream's duplicate window. A *redelivery* after a handler failure is not.

## Debugging

NATS authenticates every connection now, and `auth.conf` is least-privilege per identity -
the `nats` CLI needs a credential too, and not every debugging command has one that fits:

```bash
set -a; . infra/nats/creds/observer.env; set +a
nats sub 'evt.>'                              # watch facts as they happen - observer covers this
```

`observer`'s permissions (`infra/nats/auth.conf`) are exactly `subscribe: evt.>` and nothing
else - no `rpc.*`, no `$JS.API.>`. That means `make streams`, `nats consumer report`,
`nats stream view` and `nats sub 'rpc.project.>'` are not covered by any credential
documented in `infra/nats/RUNBOOK.md` as of this writing. If one of them errors with
`Permissions Violation`, that is not a config mistake to chase - check
`infra/nats/RUNBOOK.md` for whether a broader debug credential has since been added, or ask
whoever owns `infra/nats/` before assuming these still work as written.

| Symptom | Cause |
| --- | --- |
| `SERVICE_UNAVAILABLE` | no subscriber. The service is not running, or the subject differs. |
| `authentication error - Nkey ""` | the `nats` CLI has no credential - see above |
| `Permissions Violation` from a `nats` CLI command | that identity's `auth.conf` permissions don't cover the subject - see above, this may be a known gap rather than something to fix locally |
| Reply is `UNTRUSTED_ENVELOPE` | `ENVELOPE_SECRET` differs between processes. |
| Handler runs twice | consumer is not idempotent. Fix the handler, not the stream. |
| Consumer pending climbing | handler throws and NAKs. Check the service log. |
| Works locally, not in prod | streams were never created. Run `pnpm nats:bootstrap` with `bootstrap.env` exported. |

## Never

- Import from another service. Services talk over subjects; shared types go in
  `@guardrail/contracts`. `pnpm guardrail` enforces this.
- Query another service's tables, even though the database happens to be the same one.
- Create a stream or consumer outside `packages/transport/src/streams.ts`.
