---
name: vendor-adapter
description: Use when integrating, wrapping, upgrading or replacing a third-party service - auth provider, billing provider, database, message broker, email. Covers where vendor code is allowed to live and how to keep the swap cost to one file.
---

# Vendor adapters

Covers: normalizing identity (1:01:35).

## Rule

Third-party API shapes live in exactly one file per vendor. Everything above it speaks a
shape this platform defined. If a vendor renames a field, one file changes and nothing else
in the repo notices.

| Vendor | The one file | Everything above it sees |
| --- | --- | --- |
| Better Auth | `packages/auth/src/identity.ts` | `GatewayIdentity` |
| Autumn | `packages/billing/src/autumn.adapter.ts` | `Entitlements` from the registry |
| Postgres / Drizzle | each service's `*.service.ts` | plain function calls |
| NATS | `packages/transport/src/connection.ts`, `request.ts` | `rpcRequest`, `publishCommand` |
| Upstash | `apps/web/src/gateway/ratelimit.ts` | `{ ok, retryAfterSeconds }` |

## Writing one

1. Define the shape **this platform** wants first, in the registry or contracts. Do not
   start from the vendor's response type.
2. Read the vendor response defensively in one mapping function. Optional chaining, no
   assumptions about nesting.
3. Degrade rather than throw when the vendor is down, and say so in a comment. Billing
   being unreachable must not lock paying customers out; it returns the free plan and logs.
   Never degrade *upwards* - an outage must not silently grant a paid plan.
4. Normalise untrusted enum values downwards. `normalizeRole` maps an unknown role to the
   least privileged one, never the most.

## Prefer third-party for anything commodity

Auth, billing, email, search. More public documentation means better and more consistent
output, and the adapter keeps you from being locked in. Build from scratch only where the
thing *is* your product.

## Before upgrading a vendor SDK

Check the adapter's comments - the Autumn one notes that v1 and v2 differ (`autumn.track({customer_id})`
versus `autumn.customers.track({customerId})`). Run `pnpm verify`, then exercise the one
file, not the whole app.
