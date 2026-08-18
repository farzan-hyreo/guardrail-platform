---
name: the-block
description: Use when adding or changing an endpoint, when a request is being denied and you need to know which gate refused it, or when tempted to add an auth, permission, plan, rate limit or audit check inside feature code. Explains the eleven gates and where each one lives.
---

# The block

Covers: the block (1:14:53), enforcement (1:40:00).

The block is split across a network boundary. The gateway decides; the service enforces
what was decided. **Never add a gate to feature code** - if a check is missing, it belongs
in one of these two files.

## Gateway half - `packages/guardrail/src/gateway.ts`

Runs at the edge, where the session cookie lives.

1. **Identity** - `deps.identify(headers)`. The only cookie read in the platform.
2. **Org scoping** - taken from the session, never from input.
3. **Role gate** - `rule.minRole` from the registry.
4. **Permission gate** - `resource:operation`, derived, not written.
5. **Rate limit** - keyed per org so one tenant cannot starve another.
6. **Entitlements + plan gate** - `checkResourceAccess`, the same pure function the browser
   uses.
7. **Sign the envelope** - over the payload as well as the meta, so a captured envelope
   cannot have its body swapped in flight before it reaches the bus.
8. **Dispatch** - `rpc` waits for a reply, `command` is published durably.
9. **Verify the reply.** A queue group is not exclusivity - anything subscribed to the same
   subject can answer first. The reply's `requestId` is checked against the request, and
   its signature against the shared secret, before anything reads `reply.data`.
10. **Validate the reply body** against the contract's output schema.

## Service half - `packages/guardrail/src/service.ts`

Runs inside the service, which trusts nothing. This sequence is for the `rpc`/`command`
path (`defineService`); an `evt.*` consumer is a different code path with its own gate -
see `defineConsumer` in the `jetstream-service` skill.

1. **Verify the signature**, over the meta and the payload together. Without it, `orgId` is
   a claim from whoever published, and a signature over the meta alone would still let
   anyone on the bus keep a captured signature and swap the body beside it.
2. **Find the handler**, or reply `NOT_FOUND`.
3. **Confirm the subject.** The signed intent names one transport (`rpc` or `command`); this
   step checks the message actually arrived on the subject that transport uses. Without it,
   a valid `rpc` envelope replayed onto the command stream would become durable.
4. **Check the deadline** - `rpc` only. A command is durable on purpose: JetStream keeps
   redelivering past any timeout, so applying `timeoutMs` there would silently discard a
   queued command instead of letting it wait out an outage.
5. **Re-assert the permission** carried in the envelope.
6. **Parse the input** against the contract.
7. **Run the handler** - the only part you write.
8. **Validate the output**, sign the reply, emit `evt.<resource>.<operation>` if audited.
9. **Map errors** to wire codes.

## Reading a denial

| Error code | Which gate | Usual cause |
| --- | --- | --- |
| `UNAUTHORIZED` | 1 | no session |
| `NO_ACTIVE_ORG` | 2 | user has no membership - send to `/onboarding` |
| `PERMISSION_DENIED` | 3, 4 | registry `minRole` is higher than the caller's role |
| `UPGRADE_REQUIRED` | 6 | plan limit; `error.data` carries the decision for the UI |
| `RATE_LIMITED` | 5 | registry `rateLimit` for that resource |
| `UNTRUSTED_ENVELOPE` | service 1 or 3, or gateway 9 | wrong `ENVELOPE_SECRET`, envelope arrived on the wrong subject, or the reply failed gateway verification |
| `DEADLINE_EXCEEDED` | service 4 | `rpc` only - `timeoutMs` too low, or the service is overloaded |
| `SERVICE_UNAVAILABLE` | gateway 8 | nobody is subscribed to that subject - is the service running? |

## Adding a gate for everyone

Add it to `gateway.ts` as a numbered step, and if it must be enforced downstream too, to
`service.ts`. It then applies to every endpoint that already exists, including ones written
before the gate.

## Never

- A permission check inside a handler. The envelope already carries the answer.
- Reading `orgId` from input anywhere, for any reason.
- Catching a `GatewayError` to soften it into a success.
