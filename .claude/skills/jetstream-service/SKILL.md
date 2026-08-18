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

`pnpm subjects` prints every legal subject.

## Choosing a transport

| | `rpc` | `command` |
| --- | --- | --- |
| Caller | waits for the reply | gets `{ accepted: true }` immediately |
| Delivery | at most once | at least once, durable |
| Use for | reads, quick writes | email, PDF, third-party APIs, anything slow or flaky |
| Handler must be | correct | **idempotent** |

Declared in the registry per operation, not decided at the call site.

## Adding a service

1. Add its name to `SERVICES` in `packages/registry/src/resources.ts`.
2. Point resources at it with `owner: "<name>"`.
3. Copy `services/projects/` - `package.json`, `tsconfig.json`, `drizzle.config.ts`,
   `src/{schema,db,*.service,*.handlers,index}.ts`.
4. `defineService("<name>", handlers, { secret })` takes a flat list built with
   `handlerFor(resource, operation, fn)`, and asserts at boot that you only handle
   resources the registry says you own.
5. The subject list in `index.ts` comes from `runtime.routes` - derived, never listed.

## Consumers must be idempotent

At-least-once means the same message will occasionally arrive twice. Make replay harmless
rather than trying to prevent it:

- Unique column plus `onConflictDoNothing` (see `services/audit`).
- Check-then-skip on a natural key (see `identity` invitations).
- Never "increment a counter" in a consumer without a dedupe key.

Commands are published with `msgID: requestId`, so a *retried publish* is deduped by the
server inside the stream's duplicate window. A *redelivery* after a handler failure is not.

## Debugging

```bash
make streams                                  # stream + consumer health, pending counts
nats sub 'evt.>'                              # watch facts as they happen
nats sub 'rpc.project.>'                      # is anyone even listening
nats consumer report EVT                      # is a consumer falling behind
nats stream view CMD                          # what is stuck in the command stream
```

| Symptom | Cause |
| --- | --- |
| `SERVICE_UNAVAILABLE` | no subscriber. The service is not running, or the subject differs. |
| Reply is `UNTRUSTED_ENVELOPE` | `ENVELOPE_SECRET` differs between processes. |
| Handler runs twice | consumer is not idempotent. Fix the handler, not the stream. |
| Consumer pending climbing | handler throws and NAKs. Check the service log. |
| Works locally, not in prod | streams were never created. Run `pnpm nats:bootstrap`. |

## Never

- Import from another service. Services talk over subjects; shared types go in
  `@guardrail/contracts`. `pnpm guardrail` enforces this.
- Query another service's tables, even though the database happens to be the same one.
- Create a stream or consumer outside `packages/transport/src/streams.ts`.
