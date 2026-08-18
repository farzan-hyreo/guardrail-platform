---
name: add-feature
description: Use when adding a new resource, entity, or feature to the platform - anything that needs its own endpoints, permissions, plan limits, or database table. Walks the full path from registry entry through contract, service handler, gateway route and UI. Use this before writing any file for a new feature.
---

# Adding a feature

Covers: pattern recognition (27:29), the block (1:14:53).

Follow the order. Each step makes the next step's compile errors appear, and those errors
tell you exactly what is missing. **Do not skip ahead to the code** - the registry entry is
what generates the work.

## 1. Declare it in the registry

`packages/registry/src/registry.ts` - the one file in the registry you edit by hand.
Copy the `project` entry and edit it. Everything else in the package is computed.

```ts
invoice: defineResource({
  label: "Invoices", description: "...",
  owner: "billing",              // which service answers. Must be in SERVICES.
  featureId: "invoices",         // Autumn feature id, or null if not metered
  operations: {
    read:   op({ minRole: "member", kind: "query",    transport: "rpc", consumes: false, audit: false, timeoutMs: 3000 }),
    create: op({ minRole: "admin",  kind: "mutation", transport: "rpc", consumes: true,  audit: true,  timeoutMs: 5000 }),
  },
  limits: { free: false, pro: 100, scale: "unlimited" },   // false = not in that plan
  rateLimit: { max: 60, windowSeconds: 60 },
  nav: { href: "/invoices", label: "Invoices", order: 5 }, // or null
  upgrade: upgradeCopy("invoice"),
}),
```

Choosing values:
- `transport: "command"` when the work involves an external system that can be slow or
  down (email, PDF render, third-party API). Otherwise `"rpc"`.
- `consumes: true` only when the operation adds a unit that counts against a plan limit.
- `audit: true` for anything a customer might have to explain to an auditor.

Now run `pnpm typecheck`. It will fail in `contracts.ts`. That is the guardrail working.

## 2. Write the contract

`packages/contracts/src/resources/<name>.contract.ts`, then register it in `contracts.ts`.
One `input` and one `output` schema per declared operation. The typecheck error goes away
when every operation has one.

## 3. Write the service

In `services/<owner>/src/`:

- `schema.ts` - the table. `organizationId` is a plain `text` column, never a foreign key
  to another service's table.
- `<name>.service.ts` - queries only. Every function takes `organizationId`. Imports
  `server-only`.
- `<name>.handlers.ts` - business rules only. Add entries to the service's handler list
  with `handlerFor("invoice", "create", async ({ ctx, input }) => ...)`. Input and output
  are inferred from the contract, so never annotate them. Throw `ServiceError` with a code
  from `@guardrail/contracts`.

  **Never accept an org id as input.** It arrives as `ctx.orgId` from the signed envelope,
  and `pnpm guardrail` fails the build if a contract asks for one.

Then `pnpm --filter @guardrail/service-<owner> db:generate && db:migrate`.

## 4. Add the gateway route

`apps/web/src/gateway/routers/<name>.router.ts` - one line per operation:

```ts
export const invoiceRouter = createTRPCRouter({
  list: gatewayQuery("invoice", "read"),
  create: gatewayMutation("invoice", "create"),
});
```

Register it in `routers/_app.ts`. Never write anything else in a gateway router - no
conditionals, no database, no transformation. ESLint will stop you.

## 5. Build the UI

`apps/web/src/features/<name>/`. Wrap any control that creates or changes something in
`<Gate resource="invoice" operation="create">` with an upgrade `fallback`. See the
`client-mirror` skill.

## 6. Verify

```bash
pnpm verify         # typecheck + biome + architecture check
pnpm subjects        # the new subjects should appear
make dev             # create one through the UI, then: make logs
```

## Stop and ask if

- The resource does not belong to exactly one service.
- Two services would both need to write the same table. That means the boundary is wrong -
  do not solve it with a shared schema package.
