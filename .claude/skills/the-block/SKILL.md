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
7. **Sign the envelope** - the decision now travels with the request.
8. **Dispatch** - `rpc` waits for a reply, `command` is published durably.
9. **Validate the reply** against the contract's output schema.

## Service half - `packages/guardrail/src/service.ts`

Runs inside the service, which trusts nothing.

1. **Verify the signature.** Without it, `orgId` is a claim from whoever published.
2. **Check the deadline.** Nobody is waiting; do not spend a query on it.
3. **Find the handler**, or reply `NOT_FOUND`.
4. **Re-assert the permission** carried in the envelope.
5. **Parse the input** against the contract.
6. **Run the handler** - the only part you write.
7. **Validate the output**, emit `evt.<resource>.<operation>` if audited.
8. **Map errors** to wire codes.

## Reading a denial

| Error code | Which gate | Usual cause |
| --- | --- | --- |
| `UNAUTHORIZED` | 1 | no session |
| `NO_ACTIVE_ORG` | 2 | user has no membership - send to `/onboarding` |
| `PERMISSION_DENIED` | 3, 4 | registry `minRole` is higher than the caller's role |
| `UPGRADE_REQUIRED` | 6 | plan limit; `error.data` carries the decision for the UI |
| `RATE_LIMITED` | 5 | registry `rateLimit` for that resource |
| `UNTRUSTED_ENVELOPE` | service 1 | `ENVELOPE_SECRET` differs between gateway and service |
| `DEADLINE_EXCEEDED` | service 2 | `timeoutMs` too low, or the service is overloaded |
| `SERVICE_UNAVAILABLE` | 8 | nobody is subscribed to that subject - is the service running? |

## Adding a gate for everyone

Add it to `gateway.ts` as a numbered step, and if it must be enforced downstream too, to
`service.ts`. It then applies to every endpoint that already exists, including ones written
before the gate.

## Never

- A permission check inside a handler. The envelope already carries the answer.
- Reading `orgId` from input anywhere, for any reason.
- Catching a `GatewayError` to soften it into a success.
