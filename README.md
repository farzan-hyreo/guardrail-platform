# Guardrail platform

A multi-tenant SaaS starter split into a Next.js gateway and four NATS JetStream services,
where the architecture is enforced by the compiler, the linter and the service runtime
rather than by documentation.

Better Auth for identity and organisations. Autumn for pricing and metering. Drizzle per
service. tRPC as the gateway. shadcn/ui for the interface. Biome for lint and format,
TypeScript at full strictness.

---

## The shape

```
browser
   │ HTTP
   ▼
Next.js gateway ── authorises, signs an envelope ──┐
   │ tRPC                                          │
   ▼                                               │
 NATS  ── rpc.* request/reply ────────────────────▶│  projects   identity   billing   audit
        └─ cmd.* durable commands ────────────────▶│      │          │         │        │
                                                   │      ▼          ▼         ▼        ▼
                                          evt.* ◀──┘   own schema  own schema Autumn  own schema
                                            │
                                            └──▶ audit consumer   billing meter consumer
```

- The **gateway** decides who may do what, and has no database dependency in its
  `package.json`. It cannot query anything even by mistake.
- **Services** execute. Each owns its schema and migrations. They never import each other.
- **Audit and metering are consumers**, not code in the request path. A service cannot
  forget to audit, because it never audits - it succeeds and the event does the rest.

## Quick start

```bash
pnpm install
cp .env.example .env          # BETTER_AUTH_SECRET and ENVELOPE_SECRET are required
make up                       # NATS + Postgres, then create the streams
make migrate                  # each service migrates its own tables
make dev                      # gateway + four services
make verify                   # typecheck + Biome + architecture check
make fix                      # format, autofix, repair
```

`make help` lists everything. Autumn and Upstash keys are optional - without them everyone
is on the free plan with an in-process limiter, so a fresh clone runs.

---

## What holds it together

### 1. The registry decides, in one pattern

The registry is two files. `registry.ts` is the only one anyone edits, and every entry in it
has the same shape:

```ts
project: defineResource({
  owner: "projects",                    // which service answers
  featureId: "projects",                // Autumn feature
  operations: {
    create: op({ minRole: "admin", kind: "mutation", transport: "rpc",
                 consumes: true, audit: true, timeoutMs: 5000 }),
  },
  limits: { free: 2, pro: 25, scale: "unlimited" },
  rateLimit: { max: 60, windowSeconds: 60 },
  nav: { href: "/projects", label: "Projects", order: 1 },
  upgrade: upgradeCopy("project"),
}),
```

`derive.ts` computes everything else from it in one pipeline — permission strings,
TypeScript unions, Better Auth access control, NATS subjects and routes, queue groups, nav
entries, route guards, plan gates, timeouts, audit and metering behaviour. Nothing in
`derive.ts` is written by hand, and `pnpm guardrail` fails the build if data appears there.

`defineResource` uses a `const` type parameter, so literal types survive without `as const`,
and a single `fromKeys` helper builds every exhaustive `Record` — one auditable assertion
in the whole package instead of a cast per derivation.

### 2. Contracts make the wire type-safe

`ContractMap` is a mapped type over the registry:

```ts
export type ContractMap = { [K in ResourceKey]: { [O in OperationOf<K>]: Contract } };
```

Declare an operation without a contract and the build fails. You cannot ship a subject
nobody can parse.

### 3. The block, split across the network

The single-process version had one middleware. Distributed, it has two halves that must not
trust each other:

**Gateway** (`packages/guardrail/src/gateway.ts`) — identity → org scoping → role →
permission → rate limit → entitlements → plan gate → **sign the envelope** → dispatch →
validate the reply.

**Service** (`packages/guardrail/src/service.ts`) — verify signature → check deadline →
find handler → re-assert permission → parse input → run handler → validate output → emit
event → map errors.

The envelope is the reason this works. `ctx` used to be trustworthy because only our code
could build it; on a bus, anything with credentials can publish. So the gateway's decision
travels HMAC-signed, and a service that skips verification cannot be written — `defineService`
does it before your handler runs.

### 4. A gateway route is one line

```ts
export const projectRouter = createTRPCRouter({
  list: gatewayQuery("project", "read"),
  create: gatewayMutation("project", "create"),
});
```

The input schema comes from the contract; the handler is always "dispatch". There is no
line in a gateway router where business logic could be written, and ESLint fails the build
if you try.

### 5. Subjects are generated

`rpcSubject("project", "create")` on both sides. A literal `"rpc.project.create"` is a lint
error, because a subject typo is a request that hangs with no compiler to catch it.

`pnpm subjects` prints every legal subject.

### 6. Enforcement, on four rungs

| Rung | Covers |
| --- | --- |
| **TypeScript** | full strict plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `erasableSyntaxOnly`. No `any`, no `!`, two commented assertions in the whole repo. |
| **Biome** | format, lint, import organisation, and every package boundary via `noRestrictedImports` overrides. |
| **GritQL plugins** (`tools/grit/`) | raw subject literals, `process.env` outside `@guardrail/env`, missing `server-only`. |
| **`tools/guardrail-check.ts`** | the relational rules no pattern language can see: cross-service imports, business logic in a gateway router, and **an org id in a contract input**. |

Plus a boot-time throw: a service defining a handler for a resource it does not own refuses
to start.

Biome cannot express "compare this file's path to what it imports", so those three rules
live in a 140-line checker instead of being written down and hoped for. It runs in
`pnpm verify` and repairs what it can with `--fix`.

### 7. Claude skills

`.claude/skills/` — thirteen skills, plus four slash commands (`/feature`, `/endpoint`,
`/trace`, `/verify`). Start with `guardrail-mindset`; it routes every task to the right one.

They are **task-shaped rather than lecture-shaped**: skills trigger on what you are about to
do, so `add-feature` beats a skill per curriculum module. Each skill names the modules it
encodes.

---

## Layout

```
apps/web/                     gateway + UI. No database dependency.
  src/gateway/                init, deps, procedures, one-line routers
  src/features/               UI per feature
  src/app/(dashboard)/        route guard for pages the gateway never sees
tools/
  grit/                       GritQL lint plugins
  guardrail-check.ts          the relational architecture rules
packages/
  registry/                   registry.ts (edit) + derive.ts (computed) + access.ts
  contracts/                  envelope, signing, wire errors, contract map
  transport/                  NATS connection, rpc, publish, consumers, streams
  guardrail/                  the block: gateway.ts + service.ts
  auth/                       Better Auth + identity adapter
  billing/                    Autumn adapter
  db/                         Drizzle factory. No tables.
  ui/                         shadcn components, Gate, ViewerProvider
  env/                        every environment variable, read once
services/
  projects/  identity/  billing/  audit/
```

## Adding a feature

Registry entry → let `pnpm typecheck` fail → contract → service handler → one-line gateway
route → UI. Each step's errors define the next step's work. The `add-feature` skill has the
detail; `/feature <description>` runs it.

## Trade-offs worth knowing

**Better Auth writes, identity service reads.** Better Auth owns cookies and HTTP, so it
runs in the gateway and writes `member` / `invitation` / `organization`. The identity
service owns the migrations and the queries. That keeps Better Auth's hooks and expiry logic
intact at the cost of two packages knowing those tables. If you outgrow it, move invitation
writes fully into the identity service and have the gateway publish a command.

**Entitlements are cached for 30s at the gateway.** Otherwise every read in the product
carries an extra network hop. Invalidate on `evt.billing.manage` if you need it tighter.

**Both halves check permissions.** Deliberately redundant: a gateway bug should be a bug,
not a data breach.

**One Postgres instance, separate schemas per service.** Fine to start, and the code has no
cross-service queries, so splitting the instances later is a config change.

## Verify before you ship

Nothing here has been typechecked — no `node_modules`. Expect `pnpm verify` to surface
signature mismatches on first install, particularly:

- **nats.js v3** splits into `@nats-io/transport-node` + `@nats-io/jetstream`. Consumer and
  stream config live in `packages/transport`; that is the only place to fix.
- **autumn-js** has both a v1 (`autumn.track({customer_id})`) and v2
  (`autumn.customers.track({customerId})`) shape. One adapter file.
- **Better Auth** — run `pnpm auth:generate` and diff against `packages/auth/src/schema.ts`
  rather than trusting hand-written tables. Copy any changes into `services/identity/src/schema.ts`.
- **`@trpc/tanstack-react-query`** — the `useTRPC()` pattern in `apps/web/src/trpc/react.tsx`.
- **GritQL plugins** are the least-verified part here. Biome 2.5 added plugin code fixes and
  per-plugin `includes`, but the query dialect is still narrower than a JS AST rule. Run
  `pnpm check` once; if a plugin misfires, delete it — `tools/guardrail-check.ts` already
  covers the same three rules as a backstop.
- **`exactOptionalPropertyTypes`** is the strictest flag enabled and the most likely to
  produce first-install errors, mostly where an optional field is passed as `undefined`.
  The fix is always to build the object conditionally, never to loosen the flag.

## Licence

MIT.
