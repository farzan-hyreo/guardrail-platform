Production readiness · guardrail-platform · main

Guardrail Readiness Audit
Eleven parallel auditors read the tree; a second, adversarial pass tried to refute every claim against the real files and the installed dependencies. What survived is below, in the order it should be fixed. No file in the repository was modified.

11
Critical
45
High
81
Medium
51
Low
243
Raw → 188 clustered
The short version
The architecture is sound and, in several places, better than the review that prompted this. What is not sound is everything around it: the data layer, the money layer and the deployment story. Three defects stop the product working at all before any attacker is involved.

Read before acting
Another process was writing to this repository while the audit ran — README.md, signing.ts, gateway.ts, service.ts and guardrail-check.ts all changed inside the window, and apps/web/src/gateway/replay.ts plus infra/redis/ appeared mid-run. Findings are pinned to the tree as it stood at that point. Re-check line numbers before applying a fix, and note that two probe files (packages/guardrail/probe-binding.ts, infra/redis/probe.mjs) are still in the tree.

Three things break the running product today
Every list page throws. The bus codec is plain JSON, so a Date crosses the wire as an ISO string, and the gateway then validates the reply with a schema that declares z.date(). /projects, /team, /audit and organization.read each raise a ZodError for any organisation holding at least one row — and there is no error boundary anywhere in apps/web/src/app, so the user gets a bare Next.js 500.
Nothing can be deployed. There is no build script, no Dockerfile and no process manager; all four services start with tsx, a devDependency. No migration has ever been committed, and make migrate generates DDL from live TypeScript at deploy time — against four packages that share one __drizzle_migrations journal, where drizzle's high-water-mark comparison silently skips a whole package's migration.
The money is wired to the wrong customer. autumn() is mounted with no options, so the plugin bills the user id while autumn.adapter.ts reads entitlements for the organisation id. The <PricingTable/> on the billing page is the only upgrade path the product ships, and every purchase through it is credited to a customer nobody reads.
Underneath those, the recurring shape is the same one your own review identified: a decision is made in one place and the thing that enforces it lives somewhere the decision cannot reach. The registry decides a seat limit; the counter that gates it is an asynchronous meter that only ever increments. The block signs an envelope; the dedup store that would make it single-use was written into apps/web, where the block cannot import it. The check ladder forbids business logic in a gateway router; the rule only looks inside one directory.

Your seven weaknesses, re-judged
Two are already closed by work in the tree. Four stand, two of them for a different reason than stated. One is understated.

Your claim	Verdict	What is actually true now
1. Checker evasion — defineService builds subjects with template literals	Closed	Gone. Each handler is matched against the registry's own ROUTES and takes route.subject from there (service.ts:144–169). The replacement is stronger than the helper you asked for: it also refuses at boot when a service answers for a resource the registry gives to somebody else.
2. Replay window — no nonce or request-id dedup store	Stands, worse	A store now exists (apps/web/src/gateway/replay.ts) and nothing imports it — and it sits in apps/web, so the call site its own header names (service.ts step 2b) is unreachable. Its production guard therefore never runs either, so a deploy without Upstash boots believing dedup exists. Commands are worse than you said: checkFreshness exempts them from the deadline entirely, so a captured cmd envelope never expires, and republishing every three minutes clears the 2-minute JetStream duplicate window. Real mitigation you do have: infra/nats/auth.conf grants publish on rpc.*/cmd.* to the gateway nkey alone.
3. One shared symmetric secret for all services	Stands, medium	The concrete scenario — a compromised audit forging a member.delete — is already blocked by per-identity NATS permissions: no service may publish to any rpc subject, and each may publish only its own evt subjects. The durable defect is different: RequestMeta carries no keyId, so neither per-service keys nor rotation can be introduced without a wire break — and rotating the secret today is a full-fleet outage. Read it together with the critical below: .env.example ships a placeholder that required() happily accepts as a production key.
4. Rate limiting falls back to in-process	Half closed	Closed for the product surface: ratelimit.ts now throws at boot in production without Upstash. Open, and more serious, for the surface dispatch never sees: Better Auth's own limiter is unconfigured, so it defaults to a per-process memory map and keys on an unvalidated X-Forwarded-For. Sign-in and sign-up are effectively unlimited, and sign-up mints a tenant.
5. Entitlement cache — wire the invalidation hook	Stands	invalidateEntitlements has zero callers. But the TTL is the smaller half: because the cached usage is frozen for the window, a burst of creates all read usage = 0. Shortening the TTL does not fix it — the counter is asynchronous by construction.
6. checkResourceAccess — check-then-write is not atomic	Confirmed	Correct, and this is the highest-value architectural fix in the set. Sharpened: projectService.countActive, the authoritative count, already exists and is referenced nowhere. The fix is wiring, not new query code. Note the counter it is racing is also monotonic — deletes never decrement — so an org that creates and deletes two projects on the free plan is permanently capped at zero.
7. noBusinessLogicInGateway is keyword-based	True, wrong hole	The bluntness is real but harmless while routers stay generated. The hole that matters is the path guard: the rule returns early unless the file lives under gateway/routers/, so an entire router defined elsewhere and referenced from _app.ts is never examined. And signedEnvelopeFor, signRequest, rpcRequest and publishCommand are importable from any file in apps/web — six lines in a route handler mint an owner-role envelope for an arbitrary org id.
Six root causes
188 findings collapse into six recurring mistakes. Fixing the cause is cheaper than fixing its instances.

A. The gate and the counter live on opposite sides of the network
Plan limits are decided at the gateway from a snapshot that is cached for 30 seconds and fed by a meter that only advances after the write, from an event stream. Nothing downstream re-checks — project.handlers.ts says so in a comment. So the cap is advisory in three independent ways at once: stale, asynchronous, and unenforced at the point of write. The same asymmetry makes deletes invisible, which turns every limit into a lifetime quota.

B. Failure modes were chosen once, globally, instead of per call
Every degrade path returns EMPTY_ENTITLEMENTS, which is a plausible-looking free plan rather than a marker of ignorance. During a billing blip a paying tenant is told they are on the free plan and redirected off their own audit log, while a free tenant's quota check reads usage = 0 and passes forever. One value cannot serve both directions; the degraded state has to be representable.

C. Written, documented, never wired
A striking number of controls exist as code with no call site: the replay store, invalidateEntitlements, projectService.countActive, billing.setUsage, ensureCustomer, traceparent, audit_log.metadata, the ip on the gateway context, and the "dead letter" that serve.ts promises in a comment and no stream configures. Each reads as a working feature to the next person.

D. The enforcement ladder has a floor, not walls
The rules are excellent inside the paths they inspect and blind outside them. no-process-env covers **/*.ts but not .tsx, and two files already read process.env directly. noBusinessLogicInGateway only looks under one directory. The auth-endpoint completeness check enumerates one Better Auth plugin, so the fourteen mounts the Autumn plugin adds have never been judged. And nothing runs pnpm verify — no CI, no hook — while pnpm check currently fails on 56 diagnostics, including a Biome CSS parse error on globals.css.

E. At-least-once delivery without at-least-once handling
consume() is voided at all four call sites, so a loop that ends silently stops audit and metering with the process still alive and healthy-looking. Five deliveries with a fixed 2-second nak is a ten-second total retry budget — shorter than any real database failover. The meter increments with no dedupe key, which the repo's own skill explicitly forbids. And publishEvent sits inside the handler's try, so a bus hiccup turns a committed write into an INTERNAL the customer retries.

F. Auth was hardened at the org surface and left open everywhere else
Eleven Better Auth organisation endpoints were correctly pulled inside the block. The credential surface was not touched at all: no email verification, no password policy, no lockout, an unconfigured limiter, no sign-up page and no sign-out control. Two of the seven endpoints deliberately kept — accept-invitation and the Autumn mounts — write membership and billing state outside every gate.

Ship blockers, in order
Sequenced so each step is safe to land on its own. Steps 1–4 make the product work; 5–9 stop it losing money and data; 10–14 make it deployable and observable.

Make the wire and the schema agree
Replace z.date() with z.coerce.date() in every output DTO. The MAC is unaffected — canonicalisation maps both forms to the same ISO string. Add a round-trip test that pushes each contract output through JSON.parse(JSON.stringify(x)) and re-parses it.

packages/contracts/src/resources/{project,identity,organization,audit}.contract.ts
Add error boundaries
Every dashboard page awaits a blocking server call in the component body, and one unavailable service yields a bare 500. A segment boundary keeps the sidebar; a global one is needed because the dashboard layout itself can throw.

apps/web/src/app/(dashboard)/error.tsx, apps/web/src/app/global-error.tsx
Point Autumn at the organisation
autumn({ customerScope: "organization" }). Until this lands, every purchase is credited to a customer no code reads. Then close the fourteen /api/auth/autumn/* mounts, which carry no role gate, no rate limit and no audit row, and drive checkout through the billing.checkout route that already exists and has no caller.

packages/auth/src/auth.ts:133, apps/web/src/app/api/auth/superseded.ts
Give a user with no organisation a way back in
An owner who deletes their only workspace is locked out permanently: identify() returns null, the layout redirects to sign-in, sign-in re-resolves to no membership, repeat. /onboarding cannot help — it calls an owner-gated, plan-gated operation that needs an active org to build an envelope, and nothing links to it. Re-resolve to the earliest remaining membership, return a distinct no-org identity when there is none, route that to onboarding, and wrap the signup hook's two inserts in a transaction.

packages/auth/src/identity.ts:29, packages/auth/src/auth.ts:85, app/(dashboard)/layout.tsx:24
Reject placeholder secrets at boot
required() accepts the literal shipped in .env.example. BETTER_AUTH_SECRET on a published value is a remote session-forgery bypass that needs no bus access at all. Add a requireSecret() that enforces length and a deny-list, and empty those two lines in the example file. The pattern already exists twelve lines away for NATS_NKEY_SEED.

packages/env/src/index.ts:12–19, .env.example:13,19
Make the owning service authoritative for counted limits
The gateway decision stays — it is the cheap refusal. Add the real one where the count is a local query and ctx.plan arrives signed: count inside the same transaction as the insert and throw UPGRADE_REQUIRED. countActive and countSeats already exist.

services/projects/src/project.handlers.ts:28, services/identity/src/index.ts
Make metering absolute, idempotent and loud
Three coupled defects: track swallows every error and the message is acked anyway; there is no idempotency key, so a redelivery double-bills; and nothing ever decrements. Pass meta.requestId as Autumn's idempotency_key (the SDK supports it), let transport failures throw so JetStream retries, and publish the authoritative count with setUsage instead of incrementing.

packages/billing/src/autumn.adapter.ts:83–110, services/billing/src/index.ts:71–77
Represent "we do not know" in entitlements
Keep a last-known-good value per org with no TTL and serve it on failure; add an explicit unknown state for the case where nothing was ever known, and make the plan gate refuse counted writes in that state rather than reading usage = 0 as headroom. Also make AUTUMN_SECRET_KEY required in production, as NATS_NKEY_SEED already is.

apps/web/src/gateway/deps.ts:42–61, packages/registry/src/derive.ts:229–234
Add the last-owner guard to member.delete
assertNotTheLastOwner exists and is called from two of the three paths that can reach zero owners. The third removes the last owner and leaves a tenant where no operation gated at owner — billing, roles, deletion — can ever run again. Then close the read-then-write race by taking the owner rows FOR UPDATE inside the mutation's transaction.

services/identity/src/index.ts:76
Commit migrations and split the journals
Four packages generate into ./drizzle against one shared journal, and drizzle applies a migration only if its folder timestamp beats the single newest row — a global high-water mark, so a whole package's migration is silently skipped. Two packages also declare the same four tables with different columns. Pick one owner for the auth tables, give each package its own migrationsTable, commit the SQL, and drop db:generate from the deploy target.

services/*/drizzle.config.ts, packages/auth/drizzle.config.ts, Makefile:34
Wire the replay guard where it can actually run
Move the store into packages/guardrail, inject it through defineService, and claim immediately after signature verification: TTL from the deadline for rpc, from the CMD stream's max age for commands, returning the recalled reply rather than re-executing. Bound command envelopes absolutely, since the deadline is deliberately not applied to them.

packages/guardrail/src/service.ts:232, packages/contracts/src/envelope.ts (checkFreshness)
Stop losing durable work silently
Stop voiding consume() and make the loop ending an error the supervisor sees. Replace the fixed 2-second nak with real backoff, raise max_deliver, bound the prefetch so ack_wait cannot expire on the tail of a 100-message buffer, and add the dead-letter the comment already promises. Move publishEvent out of the handler's try so a bus hiccup cannot report a committed write as a failure.

packages/transport/src/serve.ts:67–93, packages/guardrail/src/service.ts:282
Make the processes deployable and observable
A build script and a Dockerfile per service (turbo already declares a dist/** output that nothing produces), a restart policy, a health endpoint that reports the bus subscription and the consumer loop rather than process liveness, an error listener on the pg pool so a failover does not kill three services at once, and eviction of the memoised NATS connection promise so one failed first connect does not brick a gateway for its lifetime.

services/*/package.json, packages/db/src/index.ts:24, packages/transport/src/connection.ts:41
Close the enforcement gaps, then make CI run them
Extend no-process-env to .tsx; drop the directory guard on the router rule and restrict publicProcedure, signedEnvelopeFor, signRequest, rpcRequest and publishCommand to the gateway directory; enumerate every mounted auth plugin, not just organization; add the reverse boot check that a service implements every operation the registry assigns it. Then add the workflow that runs pnpm verify, and fix the 56 diagnostics it currently reports.

tools/guardrail-check.ts, biome.json, packages/guardrail/src/service.ts:144
The four gate components
All four exist, all four derive from the registry, and the split between FeatureGate and PriceGate is the right one. The problems are at the edges: a default that cancels a documented default, a denial channel nothing listens to, and three components the mirror needs and does not have.

What is there
Component	Asks	State
AccessGate	Does the role hold resource:operation?	Correct. Calls the same can() the gateway calls, no fallback slot, hides on denial.
AuthGate	Does the role rank at or above a minimum?	Correct, and composed nowhere in the app. Ranks through roleAtLeast rather than comparing strings.
FeatureGate	Is the resource in the plan at all?	Correct in isolation. Renders children on limit_reached, by design.
PriceGate	Is the allowance spent?	Correct in isolation. Renders children on not_in_plan, by design.
Gate	All three, in platform order	Composition is right; the default is wrong — see below.
What is wrong
The composed default is unreachable. Gate declares fallback = null and forwards it, but FeatureGate and PriceGate decide on fallback === undefined. Through Gate the value is never undefined, so the documented UpgradePrompt default can never render. The skill's own example — <Gate> with no fallback — produces an empty header for a capped org. Forward conditionally with a spread; exactOptionalPropertyTypes requires it anyway.
The two single gates are unsafe alone. Each deliberately ignores the other's reason and renders children. member-list.tsx uses AccessGate + PriceGate with no FeatureGate, so a plan that does not include seats at all would show the invite form. It does not bite today only because every plan includes seats. Either always compose, or have each gate render null for the other's reason.
Nothing reads error.data.app. The gateway populates it with the structured failure; a repo-wide search finds the producer and no consumer. All four call sites print error.message as red text — which is exactly what the client-mirror skill forbids. A capped org gets sales copy rendered as an error with no billing link; retryAfterSeconds is computed, signed through the failure and never shown.
The viewer's default is a hand-written role. viewer.tsx seeds the context with role: "member" rather than the registry's LOWEST_ROLE. It fails closed, so it is safe — but it is a role name typed by hand in the one package whose whole claim is that none are.
A degraded viewer is indistinguishable from a free plan. During a billing outage the provider is handed EMPTY_ENTITLEMENTS with no marker, so the mirror confidently tells a Scale customer they are on Free.
The nav computes locked and nothing renders it. navAccess returns {visible, locked}; the sidebar uses only visible, so a locked item looks ordinary, and the redirect it produces carries ?locked=<resource> to a billing page that ignores the parameter. The sidebar also prints the plan key (pro) rather than PLANS[plan].label.
What to add
packages/ui/src/components/
  denial.tsx      <Denial error={e}/> + denialOf(e): GatewayFailure | null
                  UPGRADE_REQUIRED -> <UpgradePrompt/>   RATE_LIMITED -> "try again in Ns" (role=status)
                  everything else  -> message, role=alert.  No regex, no error.message parsing.
  usage-meter.tsx <UsageMeter resource="project"/>  useUsageLabel + remaining, one bar, tabular-nums
  plan-badge.tsx  <PlanBadge/>  PLANS[plan].label, never the key; renders "degraded" when unknown
  locked-nav.tsx  the locked half of navAccess, as a link to /billing?locked=<resource>

apps/web/src/app/(dashboard)/error.tsx   segment boundary, keeps the sidebar, offers reset()
apps/web/src/app/global-error.tsx        catches a throw in the dashboard layout itself
One addition to ViewerState carries the rest: readonly degraded: boolean, set when entitlements came from the failure path, read by PlanBadge and by any gate that would otherwise sell an upgrade to a customer who already bought one.

Deeper auth: the design
All five workstreams you asked for depend on one registry change. Without it, each of them has to be smuggled in outside the block — which is exactly how accept-invitation and the Autumn mounts ended up ungated.

The keystone: operations that are scoped to an actor, not an org
Every envelope carries an orgId, and gate 2 refuses when there is none. That is correct for every operation the registry declares today, and it is precisely why the auth surface could not come inside: accepting an invitation, listing your own sessions, enrolling a second factor and creating your first workspace all happen when the caller has no organisation, or belongs to a different one. The seven endpoints in the KEPT table are not seven judgement calls; they are one missing concept, written down seven times.

// packages/registry/src/define.ts
export type OperationRule = {
  readonly minRole: OrgRole;
  readonly kind: "query" | "mutation";
  readonly transport: "rpc" | "command";
  readonly scope: "org" | "actor";   // <- the addition
  readonly consumes: boolean;
  readonly audit: boolean;
  readonly timeoutMs: number;
};
Everything else follows by derivation, which is the point:

The gateway applies gate 2 (NO_ACTIVE_ORG) and the role gate only to scope: "org". An actor-scoped envelope carries the user and an empty org.
The service gets a discriminated context: OrgContext has orgId, ActorContext does not. A handler for an actor-scoped operation then cannot compile a query scoped to an organisation, and the tenancy story stops resting on "there is always an orgId".
The architecture check gets its mirror rule: an actor-scoped contract may not name an org id either, and an org-scoped one may not omit the scope.
The audit trail gains the events it is missing today — sign-in, sign-out, password change, second-factor enrolment, invitation accepted — because they are now operations, and operations emit evt by declaration.
1. Credential hardening
Configuration, plus one gate. Turn on requireEmailVerification and a real password policy with a breach check in a verify hook; give Better Auth's limiter the same Upstash backend the gateway uses (extract the store into a shared module so the two cannot drift), and set advanced.ipAddress.trustedProxies so the limiter stops keying on a header the client controls. Lockout needs a table — a failed_sign_in in the identity service, keyed on email and IP, checked in the sign-in path. Note that the product currently ships no sign-up page and no sign-out control at all, so this workstream includes building both.

2. Session lifecycle
Declare a session resource, actor-scoped, owned by identity: read lists the caller's sessions with device and last-seen, delete revokes one or all. That gives you sign-out-everywhere and a devices page as ordinary registry entries, with audit rows for free. For the 30-second blindness the cookie cache introduces, add freshSession to the operation rule and have the gateway ask identify for a database-backed read on the operations that deserve it — role changes, billing, deletion — rather than paying for it everywhere. Close the dangling activeOrganizationId at the same time: nothing clears it when the org or the membership is deleted, so identify returns null and the user is bounced to sign-in with no explanation.

3. Invitation acceptance, inside the block
This is the one place a plan check legitimately belongs downstream, and it is worth being explicit about why. Acceptance is actor-scoped: the caller is not yet a member, so the gateway cannot know which organisation's entitlements to read without doing data access, which it is not allowed to do. So invitation.accept resolves the invitation in the identity service, which then asks billing over the bus for that org's seat allowance and refuses with UPGRADE_REQUIRED if it is spent. Declare that in the registry as consumes: "service" rather than true, so the exception is a declaration rather than a handler quietly deciding a plan question.

Today acceptance runs entirely outside: the vendor's own ceiling of 100 members applies instead of the registry's 2 or 10, no evt is emitted so nothing is audited or metered, and no UI exists to reach it — invitations are written straight to the table and the delivery hook the code points at is never invoked, so no invitation has ever been sent.

4. MFA and OAuth
OAuth stays behind packages/auth, which is already the vendor boundary; the care is in the linking policy, since linking by unverified email is an account-takeover primitive. MFA enrolment and verification are actor-scoped operations. The interesting half is org policy: "this organisation requires a second factor" is a registry-shaped rule, not a per-endpoint one, so it belongs in gateway.ts as a numbered gate that refuses any operation when the org demands MFA and the session was not second-factor verified. Added there, it covers every endpoint that already exists, including the ones written before it.

5. Onboarding a new organisation
Today the first workspace is created in a database hook, after the user row has committed, as two independent inserts with no transaction — so any pool hiccup at a signup spike leaves an account with no membership, which cannot be used (sign-in loop) and cannot be re-registered (the email is unique). It also leaves no audit row and never creates the Autumn customer; ensureCustomer exists and has no callers.

Make provisioning an actor-scoped durable command — cmd.organization.provision — published at signup and executed by identity: organisation, owner membership and billing customer, idempotent on the user id, in one transaction. The audit row falls out of the declaration, the retry story is JetStream's, and /onboarding becomes reachable, which it currently is not: nothing links to it, and the operation it calls needs an active organisation to build an envelope in the first place.

All 188 findings
Every entry was produced by a dimension auditor and then re-checked by a second agent that read the same files and tried to refute it; refuted entries are not shown. Findings reported from more than one dimension are clustered on their anchor. NOTE carries the verifier's correction — severity changes, wrong line numbers, and the parts of a claim that did not survive.

Critical11
High45
Medium81
Low51
188 of 188 shown
Critical — data loss, cross-tenant exposure, auth bypass or revenue loss · 11
critical
Plan limits bypassable by burst: only enforcement reads a 30s-stale usage snapshot
Gateway
apps/web/src/gateway/deps.ts:22
WhenVerified end to end. checkResourceAccess (packages/registry/src/derive.ts:259-281) compares entitlements.usage[resource] against limitFor(plan); usage comes from billing.getEntitlements -> Autumn (packages/billing/src/autumn.adapter.ts readUsage), which is only advanced by billing.track in the async evt.> metering consumer (services/billing/src/index.ts, durable 'billing-meter'). deps.ts:22-23 caches the snapshot for 30s per org. project.create is rate limited at 60/60s (registry.ts:187) and services/projects/src/project.handlers.ts:29 explicitly does not re-check ('The plan limit was already refused at the gateway'). A free org with 0 projects firing 60 concurrent project.create passes gate 6 (gateway.ts:182) 60 times with used=0 and lands 60 projects on a 2-project plan; repeat every 30s. Same shape for organization.create (services/identity/src/index.ts:137, no count check) and member.create, which is worse because it is a command: the gateway returns accepted immediately and the usage never moves before the next call.

FixMake the owning service authoritative for counted limits. In services/projects/src/project.handlers.ts (create handler, around line 29) do the insert inside a transaction that first SELECT COUNT(*) ... WHERE organization_id = ctx.orgId and compares against limitFor('project', ctx.plan) from @guardrail/registry (ctx.plan is on ServiceContext, packages/guardrail/src/service.ts:264, and comes from the signed envelope), throwing ServiceError('UPGRADE_REQUIRED'). Mirror it in services/identity/src/index.ts for organization.create and for the member.create command handler. Additionally note packages/billing/src/autumn.adapter.ts:31 - with AUTUMN_SECRET_KEY unset the adapter returns FALLBACK { plan: free, usage: {} } for every org, so today counted limits are not enforced at all on a deployment that has not configured Autumn.

NoteConfirmed against all four files. Severity critical stands (revenue loss). The auditor's '120 across a window boundary' detail is the fixed-window interaction from the separate finding and is not needed - 60 in one window already breaks a 2-project plan.

critical
Hard plan caps are advisory: the 30s entitlements cache freezes usage, so an org can create unlimited resources inside every window
Gateway
apps/web/src/gateway/deps.ts:42
Whenapps/web/src/gateway/deps.ts:42 caches {plan, usage} together for TTL_MS = 30_000, and packages/guardrail/src/gateway.ts:180-186 takes its limit decision from that snapshot. A free org (project limit 2, usage 0) fires project.create repeatedly: every call inside the window reads the same cached usage.project === 0, checkResourceAccess allows all of them, and services/projects/src/project.handlers.ts:28 writes every row — it counts nothing. Metering only lands later via evt.project.create (services/billing/src/index.ts:76). The project rate limit (60/60s, registry.ts:187) caps this at 60 creates per minute per org, so the observed outcome is ~60 projects on a limit of 2, per gateway instance, and each gateway replica has its own Map so it multiplies by replica count.

FixTwo changes, both needed. (1) apps/web/src/gateway/deps.ts — split the cache: keep plan on the 30s TTL and fetch usage with a ~1s TTL (or uncached) when the caller is a consuming operation; pass a forUsage flag down from packages/guardrail/src/gateway.ts step 6, which already knows rule.consumes. (2) Even with a fresh fetch, Autumn's usage lags the write because metering is asynchronous, so this is not sufficient on its own — pair it with the authoritative in-service count described in the next finding.

NoteConfirmed; scenario sharpened — the original said 200 creates in 20s, but the 60/60s rate limit truncates that to ~60. Still 30x the cap, so critical (revenue loss) stands.

critical
Any apps/web file may mint a signed envelope for an arbitrary orgId - no rule restricts it
Gateway
apps/web/src/gateway/internal-envelope.ts:27 · reported by 2 auditors (crypto-envelope-replay, enforcement-types-tooling)
WhensignedEnvelopeFor is a plain export taking {orgId, resource, operation} and returns an envelope with userId "system:gateway", role "owner" and the exact permission requested, signed with env.envelopeSecret(). Nothing restricts who imports it: biome.json's apps/web override (lines 125-142) restricts only @guardrail/db, drizzle-orm, pg and @guardrail/auth/server, and tools/guardrail-check.ts inspects apps/web only under gateway/routers/. @guardrail/transport (rpcRequest/publishCommand), @guardrail/contracts (signRequest) and @guardrail/env (envelopeSecret) are all direct dependencies of apps/web. So a new apps/web/src/app/api/export/route.ts of six lines - const org = new URL(req.url).searchParams.get("org"); rpcRequest({subject: rpcSubject("project","read"), envelope: signedEnvelopeFor({orgId: org, resource:"project", operation:"read"}), timeoutMs: 4000}) - reads any tenant's data. The service does exactly what it is designed to do: the signature verifies, the subject matches, the deadline is fresh and meta.permissions carries the permission, so all eight refusals in service.ts pass. pnpm verify is green. This is the general form of the routers-directory hole and the reason that one is critical.

Fixtools/guardrail-check.ts: add a rule that the identifiers signedEnvelopeFor, signRequest, rpcRequest and publishCommand may only be referenced from files under apps/web/src/gateway/ (mirroring how noBusinessLogicInGateway is path-relational). In biome.json, add "@guardrail/transport" to the apps/web noRestrictedImports paths at line 132 and add a later override for apps/web/src/gateway/** that re-permits it, so the gateway keeps its access and app/ route handlers lose it.

critical
Autumn better-auth plugin bills the USER while entitlements are read for the ORG
Auth
packages/auth/src/auth.ts:133 · reported by 2 auditors (plan-gating-billing, auth-session-identity)
Alsoautumn() mounts ~16 ungated billing endpoints under /api/auth/autumn/*, and the Autumn customer id is the user id while every other read/write keys on the org id

WhenVerified in the vendor: node_modules/.pnpm/autumn-js@0.1.85.../dist/libraries/backend/better-auth.mjs lines 312-469 register /autumn/customers, /products, /checkout, /attach, /check, /track, /cancel, /query, /referrals/code, /referrals/redeem, /billing_portal, /entities, /entities/:entityId (GET+DELETE), /events/list, /events/aggregate — all with use: [], i.e. no session middleware and no role gate. apps/web/src/app/api/auth/[...all]/route.ts serves them because supersedes() (superseded.ts:127) only knows the twelve organisation paths, and tools/guardrail-check.ts:634-638 only enumerates organization().endpoints, so these were never audited. Two concrete failures. (a) Wrong customer identity: autumn() is called with no customerScope, so scopeContainsOrg() is false (chunk-SRJD6EXQ.mjs:3-5) and better-auth.mjs:281-287 sets customerId = session.user.id. apps/web/src/app/(dashboard)/billing/page.tsx:34 renders Autumn's <PricingTable/> under the AutumnProvider in apps/web/src/app/layout.tsx:16, so a real upgrade purchased from that widget attaches the product to a user-scoped customer, while packages/billing/src/autumn.adapter.ts:66 reads entitlements with customers.get(organizationId) and adapter.ts:120 attaches with customer_id: organizationId. The customer pays and the organisation stays on free forever — money taken, no plan granted. (b) Missing gates: the registry puts billing:manage at owner and billing:read at admin (registry.ts:281-294), yet a member can POST /api/auth/autumn/cancel, /attach, /billing_portal or /track with no minRole, no per-org rate limit, no plan gate and no evt.* (no audit row). Cross-tenant reads are NOT possible — withAuth (chunk-NRKSUO62.mjs:60-79) takes customer_id only from the session and 401s when there is none — so this is a revenue/gating defect, not a tenant leak.

FixTwo edits, not the proposed deletion. (1) packages/auth/src/auth.ts:133 -> autumn({ customerScope: "organization" }) so the plugin resolves the active organisation as the customer (chunk-SRJD6EXQ.mjs:3) and agrees with packages/billing/src/autumn.adapter.ts. (2) apps/web/src/app/api/auth/superseded.ts: add the mutating paths to SUPERSEDED — autumn/checkout, autumn/attach, autumn/cancel, autumn/billing_portal, autumn/track -> by billing:manage, instead billing.manage; and record the read paths PricingTable actually needs (autumn/products, autumn/customers, autumn/check, autumn/query) in KEPT with the reason, or supersede them to billing:read. Do NOT drop autumn() from the plugin list: apps/web/src/app/(dashboard)/billing/page.tsx:34 depends on those routes. (3) tools/guardrail-check.ts:634 mountedOrgEndpoints() -> walk auth.options.plugins (every plugin's endpoints), not just organization(), so the next plugin cannot mount unaudited doors.

NoteConfirmed with a correction and a sharpened fix. The original's cross-tenant framing is wrong (customer id can only come from the session), and its recommended remedy — deleting autumn() — would break the billing page. The decisive, certain harm is the user-vs-org customer id: every PricingTable purchase is credited to a customer nobody reads.

critical
Auth rate limiting keyed on unvalidated client-supplied X-Forwarded-For
Auth
packages/auth/src/auth.ts:66
WhenVerified in the installed dependency. auth.ts:66 is advanced: { cookiePrefix: SESSION_COOKIE_PREFIX } - no ipAddress block, so advanced.ipAddress.trustedProxies and ipAddressHeaders are undefined. @better-auth/core 1.7.0 dist/utils/ip.mjs:194 defaults ipAddressHeaders to ['x-forwarded-for'], and getIPFromHeader (same file, line ~188) with no trustedProxies takes the single-value header verbatim if isValidIP passes. better-auth 1.7.0 dist/api/rate-limiter/index.mjs:239-246 builds the limiter key as ${ip}|${path}, and the default special rule at lines 303-308 is window 10 / max 3 for /sign-in, /sign-up, /change-password, /change-email. An attacker rotating X-Forwarded-For per request gets a fresh bucket every time, so email+password stuffing is unbounded (there is no lockout anywhere in auth.ts) and sign-up is unbounded - and every sign-up runs the databaseHook at auth.ts:85 which inserts an organization + member row, minting tenants without limit and feeding the per-org-keyed gateway limiter unlimited fresh keys.

FixIn packages/auth/src/auth.ts extend the object at line 66 to advanced: { cookiePrefix: SESSION_COOKIE_PREFIX, ipAddress: { trustedProxies: [<LB/CDN CIDRs>] } } so the header is only honoured when it arrives through a known proxy hop, and add rateLimit: { customRules: { '/sign-in/*': {...}, '/sign-up/*': {...}, '/forget-password/*': {...} } }. Since sign-up mints a tenant, also consider gating org creation in the databaseHook behind an invitation or email verification.

NoteLine 66 is correct. Dependency behaviour reproduced from node_modules (@better-auth/core 1.7.0 ip.mjs:180-217, better-auth 1.7.0 rate-limiter/index.mjs:232-315). Severity critical retained: unbounded credential stuffing plus unbounded tenant creation.

critical
Autumn SDK returns {data:null,error} instead of throwing, so every Autumn failure silently reports the free plan
Billing
packages/billing/src/autumn.adapter.ts:67 · reported by 2 auditors (enforcement-types-tooling, plan-gating-billing)
WhenVerified in autumn-js dist/sdk/index.js: toContainerResult (line 430) returns {data:null,error,statusCode} for any status outside 200-299 and does not throw; instance.get (line 836) and instance.post (line 842) both go through it, and getCustomer (line 135) / handleTrack / handleAttach are thin wrappers over those. So on a 404/429/500, response.data is null and line 67's (response.data ?? response) yields the container object itself: customer.products is undefined -> readPlan returns DEFAULT_PLAN, customer.features is undefined -> readUsage returns {}. The try/catch at line 69 never fires, services/billing/src/index.ts:32 replies ok, and apps/web/src/gateway/deps.ts:42 caches "free" for 30s. A Scale org that hits one Autumn rate-limit response is downgraded to free for 30 seconds, refused at every consuming operation and bounced off /audit. Same shape for checkout (line 125, returns {url:null} on error) and track (line 84, silent no-op).

Fixpackages/billing/src/autumn.adapter.ts — destructure { data, error } from every SDK call and throw new ServiceError("SERVICE_UNAVAILABLE", ...) (from @guardrail/contracts, already a dependency of services/billing) when error is non-null or data is null. Delete the response.data ?? response idiom in getEntitlements (line 67) and checkout (line 125). services/billing/src/index.ts then replies not-ok and apps/web/src/gateway/deps.ts:46-55 takes its documented log-and-degrade path per request instead of caching a fabricated plan for 30s.

NoteOne correction to the original: it is not silent at the vendor layer — toContainerResult calls logger.error("[Autumn] " + message) and the default logLevel is "info" (dist/sdk/index.js:833), so there IS an [Autumn] ... line. There is still no platform-level log, no ServiceError and no degrade path, so the defect and the severity stand.

critical
z.date() in the contracts over a JSON transport: every list page throws on the first row
Wire
packages/contracts/src/resources/project.contract.ts:20
Whenpackages/transport/src/connection.ts:68-71 encodes and decodes NATS payloads with plain JSON.stringify/JSON.parse (no reviver, no superjson on this hop). The projects service returns drizzle rows whose createdAt is a Date (services/projects/src/project.service.ts:32-37), which serialises to an ISO string. The gateway then validates the reply with contract.output.parse(reply.data) at packages/guardrail/src/gateway.ts:272, and project.contract.ts:20 declares createdAt: z.date(), which rejects strings in every zod version. So /projects throws a ZodError for any org with at least one project; identical for /team (identity.contract.ts:19 and :60), /audit (audit.contract.ts:25) and organization.create (organization.contract.ts:31). With no error.tsx anywhere, the user gets a bare Next.js 500 for the whole dashboard.

FixChange z.date() to z.coerce.date() at packages/contracts/src/resources/project.contract.ts:19-20, identity.contract.ts:19 and :60, organization.contract.ts:31 and audit.contract.ts:25, so the shared schema revives the ISO strings the JSON codec produces on both the service and gateway sides. Add a test beside tests/registry-derive.test.ts that round-trips one contract output through encode/decode and re-parses it, so the transport boundary is covered.

critical
Shipped placeholder secrets pass required(): ENVELOPE_SECRET and BETTER_AUTH_SECRET boot on a value published in this repo
Config
packages/env/src/index.ts:50 · reported by 2 auditors (crypto-envelope-replay)
AlsoNo rotation path for ENVELOPE_SECRET: rotating it is a full-fleet outage

WhenrequireValue (lines 12-19) rejects only undefined/empty. .env.example:13 ships ENVELOPE_SECRET="generate-with-openssl-rand-base64-32" and .env.example:19 ships the identical literal for BETTER_AUTH_SECRET; README.md:47 documents cp .env.example .env as the setup step, with a comment that says only that the two are "required" - which the placeholders satisfy. A deployment that fills in DATABASE_URL and NEXT_PUBLIC_APP_URL and forgets these two boots all five processes on a public key. Envelope half: anyone who reaches the bus signs {orgId: victim, role: "owner", permissions:["project:delete"]} and defineService accepts it. Auth half is worse and needs no bus access at all - packages/auth/src/auth.ts:50 feeds the same literal to better-auth as its session-signing secret, so a stranger on the public internet mints a session cookie for any user and walks in through the front door with no NATS credential involved.

Fixpackages/env/src/index.ts: add requireSecret(name) beside requireValue that rejects values under 32 chars and rejects a literal deny-list containing the two .env.example placeholders, with the openssl rand -base64 32 instruction in the throw; point envelopeSecret and betterAuthSecret at it. Change .env.example lines 13 and 19 to empty strings so a copied file fails at boot rather than running on a published key.

NoteConfirmed and strengthened. The auditor's envelope-forgery path needs bus credentials (which are also checked in - see the creds finding), but BETTER_AUTH_SECRET is the same placeholder and is a remote auth bypass with no bus access, which is what makes this unambiguously critical. Note packages/env/src/index.ts:61 already has exactly the production-only throw this needs, for NATS_NKEY_SEED - the pattern exists and was not applied to the two HMAC keys.

critical
No migrations committed and all four packages share one drizzle.__drizzle_migrations journal — drizzle's timestamp comparison silently SKIPS a whole service's migration
Identity
services/identity/drizzle.config.ts:4
WhenStronger than reported. All four configs (services/{audit,identity,projects}/drizzle.config.ts, packages/auth/drizzle.config.ts) use out:'./drizzle', the same DATABASE_URL, and set neither migrationsSchema nor migrationsTable; ls confirms none of those drizzle/ dirs exist, so nothing is committed. I read the migrator: drizzle-orm/pg-core/dialect.js:57-62 selects only the single newest row (order by created_at desc limit 1) and applies a migration only if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis). With one shared journal, that is a global high-water mark. make migrate regenerates all four folders seconds apart with arbitrary turbo ordering, then pnpm db:migrate runs them in another arbitrary order. If identity's folder got folderMillis 1000ms later than projects' and identity migrates first, projects' migration is not applied and is not retried — it is silently below the watermark forever. The projects service then starts and every query dies with 42P01 'relation "project" does not exist', and re-running make migrate does not fix it because generate produces no new diff.

FixCommit the generated drizzle/ folders, give each package its own journal (migrationsSchema: 'identity' or migrationsTable: '__drizzle_migrations_identity' in each of services/*/drizzle.config.ts and packages/auth/drizzle.config.ts), and change Makefile:34 from pnpm db:generate && pnpm db:migrate to pnpm db:migrate so deploys never generate DDL from live TypeScript.

NoteSeverity raised from high to critical: the auditor said the migration would be 're-applied on top', but the actual drizzle behaviour I read is a silent skip, which means a service can ship with no tables at all and no error from the migrate step.

critical
Two divergent Drizzle definitions of user/organization/member/invitation, both with db:generate — whichever migrates first decides the production schema
Identity
services/identity/src/schema.ts:21
WhenVerified column-for-column. packages/auth/src/schema.ts:11-19 declares user with email_verified/created_at/updated_at; services/identity/src/schema.ts:21-26 declares the same table with only id/name/email/image. auth's member (71-81) and invitation (83-95) carry .references(... onDelete: 'cascade'); identity's (28-44) carry none. Both packages ship db:generate/db:migrate (services/identity/package.json:12-13, packages/auth/package.json:14-15) pointed at ./drizzle (both dirs absent — ls shows no drizzle folder in packages/auth or any service), so each generate emits a full CREATE TABLE. I checked drizzle-kit 0.31.10's emitter (api.mjs): it produces CREATE TABLE ${name} ( with NO IF NOT EXISTS (grep for 'CREATE TABLE' returns only that form; zero occurrences of 'IF NOT EXISTS' in the table DDL path). make migrate (Makefile:34) is pnpm db:generate && pnpm db:migrate, both turbo fan-outs with no ordering. Fresh database, identity wins the race: user is created without email_verified/created_at/updated_at, Better Auth's first signup INSERT fails 42703, and auth's migration then aborts 42P07 'relation "user" already exists'. auth wins instead: identity's migration aborts and identity records nothing in the shared journal. Either way member/invitation get cascade FKs or not by scheduler luck.

FixDelete lines 12-44 of services/identity/src/schema.ts and re-export from a single owner (export { organization, member, invitation, user } from '@guardrail/auth/schema' — that subpath export already exists in packages/auth/package.json), then remove db:generate/db:migrate from services/identity/package.json and delete services/identity/drizzle.config.ts so exactly one package emits DDL for those four tables. Add a check in tools/guardrail-check.ts that no pgTable name string appears in two *.ts schema files.

NoteReproduced against the real files and against the installed drizzle-kit emitter. The divergence is not hypothetical — the two user definitions differ by three columns today. Severity kept at critical: signup is the failure mode.

critical
A router defined outside gateway/routers/ bypasses every gateway rule
Enforcement
tools/guardrail-check.ts:287
WhenVerified: noBusinessLogicInGateway returns at line 287 unless the path contains gateway/routers/, and biome.json:244 scopes maxAllowedComplexity:1 to the same directory. checkRouterProperty (line 282) accepts any identifier this file imported, from anywhere, so admin: adminRouter in routers/_app.ts:12 with apps/web/src/features/admin/admin.router.ts holding publicProcedure.input(...).mutation(...) is accepted. publicProcedure is exported from apps/web/src/gateway/init.ts:63 with no import restriction. Correction to the payload: the auditor's db.delete(...) example would in fact be caught - biome.json:132-135 forbids @guardrail/db, drizzle-orm and pg anywhere in apps/web. The payload that is NOT caught is the bus: the ungated procedure imports signedEnvelopeFor from ../../gateway/internal-envelope plus rpcRequest from @guardrail/transport (both unrestricted), builds an envelope for an orgId taken from its own input, and the owning service serves it - no identify(), no role gate, no permission gate, no rate limit, no plan gate, no audit event, and pnpm verify green.

Fixtools/guardrail-check.ts: delete the path guard at line 287 and run noBusinessLogicInGateway on every file containing a createTRPCRouter call; additionally reject a property whose value is an imported identifier unless that specifier resolves under apps/web/src/gateway/routers/. Add a second rule that publicProcedure (and t.procedure) may only be referenced from apps/web/src/gateway/procedures.ts. Mirror it in biome.json with an apps/web override adding a noRestrictedImports entry for "@/gateway/init" and "../init" outside gateway/.

NoteConfirmed against the real code; mechanism corrected (direct DB access is already blocked by biome, the bus is not). Severity kept at critical because the resulting endpoint can name any orgId in a signed envelope.

High — breaks under realistic load, failure or ordinary use · 45
high
No error boundary anywhere in apps/web/src/app — one failing service yields a bare Next.js 500
Web app
apps/web/src/app/(dashboard)/layout.tsx:20 · reported by 2 auditors (gateway-http-web, ui-client-mirror)
WhenVerified by directory listing: apps/web/src/app and every segment under it contain only layout.tsx/page.tsx/globals.css — no error.tsx, global-error.tsx, loading.tsx or not-found.tsx, and no React boundary in the tree. Every dashboard page awaits a blocking server caller in the component body (projects/page.tsx:6, team/page.tsx:6, audit/page.tsx:11, billing/page.tsx:9). SERVICE_UNAVAILABLE maps to INTERNAL_SERVER_ERROR (packages/contracts/src/errors.ts:59), createCaller throws, and the user gets Next's production fallback with no sidebar, no message and no retry. The output-parse throw at packages/guardrail/src/gateway.ts:272 does the same.

FixAdd apps/web/src/app/(dashboard)/error.tsx as a "use client" component taking { error, reset }, rendering the platform Card with a short message, error.digest, and a Button calling reset(); living inside the (dashboard) segment keeps the sidebar. Add apps/web/src/app/global-error.tsx as well, because a throw in (dashboard)/layout.tsx itself (identify or gatewayDeps.entitlements) is not caught by a child error.tsx.

NoteConfirmed and currently load-bearing: as the first missed finding shows, /projects, /team and /audit throw on every non-empty list today, so this boundary is the difference between a retryable message and a blank crash page.

high
Autumn's /api/auth/autumn/* endpoints bypass the block entirely — any member can attach, cancel or open the billing portal
HTTP edge
apps/web/src/app/api/auth/superseded.ts:81
WhenThe autumn plugin mounts /autumn/customers, /autumn/products, /autumn/checkout, /autumn/attach, /autumn/check, /autumn/track, /autumn/cancel, /autumn/query, /autumn/referrals/*, /autumn/billing_portal and /autumn/entities* (autumn-js dist/libraries/backend/better-auth.js:2724-2830), all with use: [] — no middleware. handleReq (line 2699) only calls getSessionFromCtx; the authorisation is "is there a session". None of those paths appears in SUPERSEDED (superseded.ts:42-75) or KEPT (:81-101), so apps/web/src/app/api/auth/[...all]/route.ts:45-47 gets null from supersedes() and delegates straight to Better Auth. The registry declares billing.manage as owner-only, 20/60s rate limited and audited (registry.ts:288-298); a plain member POSTing /api/auth/autumn/cancel or /autumn/billing_portal gets none of that. Today the blast radius is capped because the customer id is the user's (finding 1) — the moment customerScope is fixed to "organization", the same POST cancels the organisation's subscription and /autumn/track inflates the org's metered usage, with no role gate, no rate limit and no audit row.

FixTwo changes. (1) apps/web/src/app/api/auth/superseded.ts — add autumn/attach, autumn/checkout, autumn/cancel, autumn/track, autumn/billing_portal, autumn/customers, autumn/query and autumn/entities to SUPERSEDED with by: "billing:manage", and drive the UI through the existing billing.checkout tRPC route (apps/web/src/gateway/routers/billing.router.ts:31, which has no caller today) instead of <PricingTable/> in apps/web/src/app/(dashboard)/billing/page.tsx:34. Read-only ones you choose to keep (autumn/products, autumn/check) go in KEPT with the reason. (2) tools/guardrail-check.ts:634 mountedOrgEndpoints only enumerates better-auth's organization plugin, so the autumn mounts were structurally invisible to the completeness check — widen it to enumerate every plugin passed to auth (or add autumn-js/better-auth explicitly) or the same gap reopens with the next plugin.

NoteConfirmed against the vendor bundle and the route file. Line corrected from 44 to 81 (the KEPT table, which is where an omission is judged). Severity high, not critical, because with today's user-scoped customer id the member acts on their own Autumn customer, not the org's — it becomes critical the instant finding 1 is fixed, so fix them together. Also added the guardrail-check root cause, which the original missed.

high
accept-invitation adds a member with no seat gate, no audit row and no metering
HTTP edge
apps/web/src/app/api/auth/superseded.ts:86
Whenorganization/accept-invitation is deliberately KEPT (superseded.ts:86-87). Verified in better-auth/dist/plugins/organization/routes/crud-invites.mjs:264-300: acceptance checks only expiry/status, a case-insensitive email match, an emailVerified requirement that is switched OFF here (shouldRequireVerifiedEmailForInvitationIdAction at crud-invites.mjs:30 returns false because advanced.generateId is unset), and membershipLimit || 100. auth.ts:122-131 passes no membershipLimit, so the ceiling is 100 while the registry declares seats free 2 / pro 10 (registry.ts:236). The member row is created by the vendor, outside the block, so no evt.member.* is ever published: services/audit has no record that anyone joined a tenant, and the billing meter (services/billing/src/index.ts:70-77) never counts the accepted seat — only the invitation. Deployment condition: any org on a seat-limited plan. A free org can be grown to 100 members with no upgrade and no audit trail.

Fixpackages/auth/src/auth.ts:122 — pass membershipLimit: (user, org) => seatLimitFor(org) derived from RESOURCES.member.limits, and add organizationHooks: { afterAcceptInvitation } that publishes evt.member.create with the org taken from the invitation row so audit and metering see it. The structural alternative the file already contemplates: declare a membership.create operation in packages/registry/src/registry.ts whose envelope takes orgId from the invitation row rather than the session, move the path into SUPERSEDED, and let the block gate it.

NoteConfirmed against the vendor source; the cited line was wrong (72 is invitation.revoke) — the KEPT entry is superseded.ts:86. Exploitation today needs an invitationId obtained out of band or from invitation.list, because finding 'invitations are never delivered' means no invite ever reaches a user; that lowers likelihood, not severity.

high
No request body size limit on the single HTTP door
HTTP edge
apps/web/src/app/api/trpc/[trpc]/route.ts:11 · reported by 2 auditors (rate-limiting-abuse)
Also429 responses carry no Retry-After header

WhenConfirmed, with a correction to the precondition. apps/web/next.config.ts sets no limit, proxy.ts imposes none, and App Router route handlers have no built-in body cap. The tRPC fetch adapter buffers and JSON.parses the whole body before any procedure resolves. The finding calls this 'unauthenticated'; strictly, /api/trpc is not in the isPublic list at apps/web/src/proxy.ts:26-30 - but proxy.ts:32 checks only request.cookies.has(name), i.e. cookie PRESENCE, never validity. So an attacker who sets a garbage better-auth.session_token=x cookie passes the proxy with no credential at all and reaches the handler with a 500MB body. A handful of concurrent such requests OOMs the gateway process; the contract's max() bounds are only checked after the whole string is resident.

FixAt the top of handler in apps/web/src/app/api/trpc/[trpc]/route.ts, read request.headers.get('content-length') and return new Response(null, { status: 413 }) above ~256KB. Because the same door is reachable with a forged cookie, also add the check in apps/web/src/proxy.ts (which already runs on every matched path) so it covers /api/auth too.

NoteThe 'unauthenticated' claim is correct in effect but for a different reason than stated - proxy.ts:32 is a presence-only cookie check, not an auth check. Severity high retained.

high
No batch size limit: one HTTP request can carry unbounded procedure calls
HTTP edge
apps/web/src/app/api/trpc/[trpc]/route.ts:12 · reported by 4 auditors (gateway-http-web, rate-limiting-abuse)
AlsoNo body-size cap and no limiter in front of the authenticated rate limiter  ·  CSRF: no origin / sec-fetch-site check on the tRPC door and no declared cookie SameSite

WhenConfirmed. fetchRequestHandler is called at route.ts:11-19 with endpoint/req/router/createContext/onError only. In @trpc/server 11.18.0 the cap is opt-in: resolveResponse-CdASWfAV.mjs:81-83 reads opts.maxBatchSize and only throws when it is typeof === 'number', so an unset value means unlimited. One POST to /api/trpc/project.read,project.read,... with 10,000 entries fans out 10,000 dispatches. Each one calls deps.identify at packages/guardrail/src/gateway.ts:124 - and identify (packages/auth/src/identity.ts:25) is not memoised, so every entry pays a getSession plus a member SELECT - all before the limiter at gateway.ts:166. The org limit refuses call 61 onward only after 10,000 session resolutions and 10,000 Upstash round trips have been paid, saturating the 10-connection pool in packages/db/src/index.ts:24.

FixPass maxBatchSize: 20 to fetchRequestHandler in apps/web/src/app/api/trpc/[trpc]/route.ts, and set the matching maxItems on httpBatchLink in apps/web/src/trpc/react.tsx:31 so the real client never trips it. Separately, memoise identify per request in apps/web/src/gateway/deps.ts (React cache) so one HTTP request resolves the session once rather than once per batch entry.

NoteReproduced the tRPC 11.18.0 default from node_modules. The identify-not-memoised amplification is confirmed and worth adding to the fix.

high
Nothing reads error.data.app — every denial renders as raw red text, which the skill explicitly forbids
Web app
apps/web/src/features/projects/project-list.tsx:72
WhenVerified: apps/web/src/gateway/init.ts:52 populates data.app from error.cause, which procedures.ts:24 sets to the GatewayFailure ({code:"RATE_LIMITED",retryAfterSeconds} / {code:"UPGRADE_REQUIRED",decision}, gateway.ts:63-70). A repo-wide grep for data.app returns only the producer — zero consumers. All four call sites print error.message in destructive text: project-list.tsx:72, member-list.tsx:109 and :110, onboarding/page.tsx:45. A free admin whose 30s-stale viewer still shows headroom clicks Create, gets UPGRADE_REQUIRED, and the sales copy is painted as a red error with no billing link; the 61st create in a minute prints "Too many requests. Try again shortly." while retryAfterSeconds sits unread.

FixAdd packages/ui/src/components/denial.tsx exporting denialOf(error: unknown): GatewayFailure | null (a type guard over error.data.app, no regex) and <Denial error={...}/> switching on code: UPGRADE_REQUIRED → <UpgradePrompt decision={…}/>, RATE_LIMITED → "Try again in {retryAfterSeconds}s" with role="status", default → message with role="alert". Add "./denial": "./src/components/denial.tsx" to the exports map in packages/ui/package.json (the "./*" catch-all maps to src/components/ui/*.tsx and will not resolve it), then replace project-list.tsx:72, member-list.tsx:109-110 and onboarding/page.tsx:45.

NoteDirectly contradicts the skill's own 'Error handling in the UI' section (.claude/skills/client-mirror/SKILL.md, final section): 'Denials arrive structured on error.data.app… Match on code.' High is right.

high
Entitlements silently degrade to the free plan on any billing failure or missing key: limits stop being enforced and paid-only resources are denied
Gateway
apps/web/src/gateway/deps.ts:55 · reported by 7 auditors (gateway-http-web, multitenancy-authz, ui-client-mirror, rate-limiting-abuse, plan-gating-billing, ops-observability-config)
AlsoBilling-outage entitlements degrade to the free plan, so the mirror (and the gateway) downgrade paying orgs  ·  Entitlements failures are never cached and never de-duplicated, amplifying a billing blip into a gateway outage  ·  Entitlements fail open to the FREE plan on a billing outage, which denies exactly the customers who pay  ·  A billing outage degrades every tenant to the free plan and costs a 4s timeout on every request  ·  The plan-limit gate fails OPEN during any billing failure, because the fallback entitlements carry an empty usage snapshot

WhenConfirmed on both branches. deps.ts:55 and :60 return EMPTY_ENTITLEMENTS = {plan:"free", usage:{}} (derive.ts:234) whenever billing refuses or is unreachable; autumn.adapter.ts:28-31,64 returns the same FALLBACK unconditionally when AUTUMN_SECRET_KEY is unset, and env.autumnSecretKey() (packages/env/src/*.ts:71) is optional, so it never fails at boot. (a) During a billing outage checkResourceAccess computes used = usage[resource] ?? 0 = 0 for every resource on every request and nothing is cached, so a free org creating projects sees 0 + 1 > 2 = false every time and can create without bound for the length of the outage. (b) In the same outage a Scale customer is refused organization.create outright, because organization.limits.free is false → reason "not_in_plan" → UPGRADE_REQUIRED. (c) The worst case is not an outage at all: AUTUMN_SECRET_KEY unset in production pins every tenant to free forever with one console-free code path — no paid plan is ever honoured and no limit is ever enforced.

FixTwo changes. In packages/billing/src/autumn.adapter.ts, make the missing-key case fatal in production — mirror apps/web/src/gateway/ratelimit.ts:102-110 and throw at module init unless an explicit BILLING_ALLOW_UNCONFIGURED escape hatch is set. In apps/web/src/gateway/deps.ts, keep a last-good entitlements value per org beyond the 30s TTL and serve it on failure, and when there is no last-good value return a value the gate can fail closed on: add usage: "unknown" handling to checkResourceAccess in packages/registry/src/derive.ts so limit checks refuse while plan-inclusion checks still honour the last-known plan.

NoteAll three branches reproduced against the code. Severity high is right, but for a reason the original scenario understates: the unconfigured-key case is permanent and silent, not transient.

high
Upstash failure silently removes all rate limiting, with no log and no fallback
Gateway
apps/web/src/gateway/ratelimit.ts:72
WhenConfirmed. Line 72 if (!response.ok) return { count: 0, resetAt }; returns silently - no console.error, no counter - and the catch at line 76 (not 82 as filed) does the same with a log. rateLimit() then evaluates 0 > max false at line 126 and returns ok:true. Any Upstash 5xx, an expired token, or exhausting Upstash's own per-plan request quota (which the platform's own traffic can do, since every dispatch spends one Upstash round trip) disables every limit in the product at once. The catch path is documented as a deliberate fail-open; the !response.ok path is not documented and logs nothing, so a 401 from a rotated token looks identical to a healthy system.

FixIn apps/web/src/gateway/ratelimit.ts: (1) log on the !response.ok branch at line 72 with response.status so a rotated token or quota exhaustion is visible; (2) keep a module-level new InMemoryStore() as a degraded fallback and delegate to it on both failure paths so a per-replica limit still applies; (3) optionally thread the registry's kind from packages/guardrail/src/gateway.ts:166 into rateLimit() and fail closed for mutations while keeping queries fail-open.

NoteLine 72 correct; the auditor's second line reference (82) should be 76. Fail-open is documented in the file header, but the silent non-2xx branch and the absence of any degraded fallback are real gaps, so high stands as a documented-but-production-breaking trade-off.

high
The replay/idempotency guard is dead code: nothing imports it, so commands have no dedup
Gateway
apps/web/src/gateway/replay.ts:138
Whenreplay.ts exports claimReplay (:138), recallReply (:145) and rememberReply (:157) and its header states the call site is 'packages/guardrail/src/service.ts - step 2b, after envelope verification and before any handler work'. Grep across apps, services and packages finds no importer: the only files matching 'replay' are replay.ts itself, comments in internal-envelope.ts, proxy.ts, service.ts:246, projects/index.ts and derive.ts. packages/guardrail/src/service.ts takes only options: { secret: string } (:136, :325) - there is no dedup injection point and no step 2b. Consequences in this dimension: (a) a captured, validly signed command republished onto the CMD stream re-executes with no gateway limiter in the path at all, since the limiter only runs at the gateway; (b) serve.ts consume() sets max_deliver: 5 (:71), so any handler that naks re-runs up to five times relying purely on ad-hoc checks - services/identity/src/index.ts:63 re-reads pending invitations, services/projects/src/project.handlers.ts:31 re-checks the slug - and organization.create (services/identity/src/index.ts:137) has only a slug check, so a redelivered command with a different slug creates a second tenant. Also note the file's own selectStore() throws in production without Upstash (:124-133), which means a production boot pays that failure mode for a store nothing uses.

FixEither wire it or delete it. To wire: extend the options parameter of defineService/defineConsumer in packages/guardrail/src/service.ts:136 and :325 with an injected { claim, recall, remember } dedup port, call claim() for rpc (ttl = deadlineAt - now + skew) and recall/remember for commands immediately after verifyRequest at :232, and pass apps/web/src/gateway/replay.ts's functions in from each service entry point (services/*/src/index.ts). To delete: remove apps/web/src/gateway/replay.ts and the boot-time Upstash requirement it imposes, and record in the registry docs that at-least-once delivery is handled per-handler.

high
Real NATS private keys are committed and the checked-in auth.conf trusts them
Infra
infra/nats/creds/gateway.env:3 · reported by 2 auditors (crypto-envelope-replay, ops-observability-config)
Wheninfra/nats/creds/gateway.env:3 contains a live seed (NATS_NKEY_SEED=SUAP7BLB...), all eight *.nk/*.env files are tracked, .gitignore lists only node_modules/.next/dist/.turbo/.env/.env.local, and infra/nats/auth.conf:24+ carries the matching public nkeys. nats.conf:2 calls itself 'the configuration the local stack and every deployment start from', and docker-compose.yml:18 mounts ./nats wholesale. Deployment condition: any environment that mounts this infra/nats directory without first running generate-auth.ts --rotate --out /secure/tmp/nats (RUNBOOK.md:178) accepts the publicly known seeds. Anyone with the repo can then connect as projects and, per auth.conf's subscribe allow-list, join the queue group on rpc.project.* - receiving real request envelopes (payloads plus meta.orgId of other tenants) and black-holing them. Forging replies still needs ENVELOPE_SECRET; reading and dropping traffic does not.

FixStop shipping the seeds: gitignore infra/nats/creds/, generate them on first run from infra/nats/dev.sh, and add a boot assertion - in infra/nats/generate-auth.ts (a --check extension) and in packages/transport/src/connection.ts - that refuses to start when env.isProduction() and the presented nkey's public half matches one of the well-known development public keys baked into the check.

NoteVerified: seeds are real and tracked, .gitignore does not cover them, auth.conf holds the matching public keys. Documented in RUNBOOK.md 'Deploying' step 1 but enforced nowhere. Severity stays high because the leak requires a specific (though very likely) deployment mistake plus network reach to :4222.

high
No committed migrations: make migrate generates schema diffs at deploy time
Repo
Makefile:34
Whenmigrate: pnpm db:generate && pnpm db:migrate. There is no drizzle/ directory and no .sql file anywhere in the tree (verified with find), while all four drizzle.config.ts files point out at ./drizzle. The SQL applied to production is therefore computed from the current schema.ts against an empty journal at deploy time: never reviewed, not guaranteed identical between staging and production, and drizzle-kit generate prompts interactively on rename-vs-drop ambiguity, which hangs a non-interactive deploy. Against a database that already has tables but no __drizzle_migrations journal the generated 'initial' migration issues CREATE TABLE over live tables and aborts part-way, leaving services partially migrated.

FixCommit the generated drizzle/ folders for services/{projects,identity,audit} and packages/auth, remove pnpm db:generate from the migrate target in the Makefile (generation is a dev step; migration is a deploy step), and document the migrate-before-roll ordering alongside infra/nats/RUNBOOK.md.

NoteVerified: no *.sql and no drizzle/ directories exist; Makefile line 34 exact.

high
Nothing runs pnpm verify: no CI, no git hook, no pre-push
Repo
package.json:14 · reported by 2 auditors (enforcement-types-tooling, ops-observability-config)
AlsoNo CI workflow, so the architecture checks that guarantee this design never run on a change

WhenThere is no .github directory and no CI config in the tree. Everything that keeps the platform coherent is a command someone must remember: pnpm verify (typecheck + biome + tools/guardrail-check.ts), pnpm exec tsx infra/nats/generate-auth.ts --check (the RUNBOOK's own remedy for 'the PR that added an operation and forgot the bus'), node infra/nats/verify.mjs, and tests/registry-derive.test.ts - which has no test script in package.json at all, so nothing runs it. Concrete outcome: a PR adds an operation to registry.ts without regenerating auth.conf; defineService binds the new subject at boot and the failure surfaces in production as a NATS 'Publish Violation' on a subject only the new build knows about.

FixAdd .github/workflows/ci.yml running pnpm install --frozen-lockfile, pnpm verify, pnpm exec tsx infra/nats/generate-auth.ts --check, pnpm tsx tests/registry-derive.test.ts, plus a job that brings up infra/docker-compose.yml, runs pnpm nats:bootstrap and node infra/nats/verify.mjs; add "test": "tsx tests/registry-derive.test.ts" to package.json so the assertion file is not orphaned.

NoteVerified (no .github, no test script). Severity lowered high -> medium: it is a process gap that makes other failures likelier rather than a defect that fails production on its own.

high
Better Auth limiter uses in-memory storage while ratelimit.ts refuses in-memory in production
Auth
packages/auth/src/auth.ts:48 · reported by 2 auditors (rate-limiting-abuse, auth-session-identity)
AlsoBetter Auth rate limiting is unconfigured: one shared bucket for every sign-in, or a spoofable one

WhenbetterAuth() declares no rateLimit and no advanced.ipAddress (auth.ts:48-66). Verified defaults: better-auth/dist/context/create-context.mjs:169-174 turns rate limiting on in production with storage 'memory' (no secondaryStorage is configured), 100/10s general; dist/api/rate-limiter/index.mjs:302-311 adds 3/10s for /sign-in, /sign-up, /change-password, /change-email. The key is getIP(req)|path (index.mjs:239-245), and @better-auth/core/dist/utils/ip.mjs:getIPFromHeader trusts x-forwarded-for only when it is a single value unless trustedProxies is set. Behind any LB that appends (nginx proxy_add_x_forwarded_for, most ingress controllers) the header has two hops, getIP returns null, and every request in the fleet shares the key 'no-trusted-ip|/sign-in/email' (index.mjs:233-245): four sign-in POSTs per 10s from one attacker deny sign-in to the whole customer base. In the single-value-XFF shape the attacker sets the header and gets unlimited password attempts. Memory storage additionally means N replicas enforce N x the limit and every deploy resets counters.

Fixpackages/auth/src/auth.ts:66 — extend advanced to { cookiePrefix: SESSION_COOKIE_PREFIX, ipAddress: { trustedProxies: [<LB CIDRs from @guardrail/env>] } }, and add rateLimit: { enabled: true, storage: "secondary-storage" } with a secondaryStorage backed by the same Upstash REST credentials apps/web/src/gateway/ratelimit.ts:46-85 already builds — extract UpstashStore into a shared module so auth and the gateway share one backend and inherit that file's fail-loud-at-boot policy (ratelimit.ts:87-112).

NoteVendor behaviour verified line by line. Which of the two failure shapes you get is deployment-dependent (single-value XFF on Vercel-style edges vs appended chains behind nginx/ingress), but both are bad and the memory-per-replica problem is unconditional for any multi-replica deploy — which is exactly the failure ratelimit.ts refuses to allow for the gateway's own limiter.

high
First-workspace creation is two un-transactional inserts run after the user row commits; any hiccup leaves an account that can never be used or re-registered
Auth
packages/auth/src/auth.ts:85
WhenVerified in the vendor: better-auth/dist/db/with-hooks.mjs:33 wraps the create.after hook in queueAfterTransactionHook, and @better-auth/core/dist/context/transaction.mjs:93-110 runs it inline when no transaction is active — so the hook runs after the user row is committed. The hook then does two independent inserts (auth.ts:88 organization, auth.ts:95 member) with no authDb.transaction. Any transient failure — pool exhaustion at a signup spike, a connection reset, a pod eviction between the two statements — commits the user with no membership. That account is then dead: identify() returns null (identity.ts:29/38) so it loops on /sign-in, and it cannot be recreated because user.email is unique (packages/auth/src/schema.ts:14). If the first insert is the one that fails, the caller also sees a 500 and believes signup failed, then hits 'email already exists' on retry. An orphan organisation row survives the other ordering.

Fixpackages/auth/src/auth.ts:85-101: wrap both inserts in await authDb.transaction(async (tx) => { ... }), exactly the pattern identityService.createOrganization already uses at services/identity/src/identity.service.ts:160-173. Add a self-heal in packages/auth/src/auth.ts:111 (session.create before hook): if findFirst returns nothing, create the workspace there with the same slugify/workspaceName helpers, so an already-orphaned account repairs itself at the next sign-in.

NoteVendor mechanism verified (queueAfterTransactionHook + no runWithTransaction around email signup). Kept at high: the trigger is any DB error inside the hook, not only a mid-hook crash, and the outcome is unrecoverable without hand SQL.

high
A user with no membership is permanently locked out in a sign-in loop with no recovery path
Auth
packages/auth/src/identity.ts:29
Whenidentify() returns null both when there is no session and when activeOrganizationId is null (identity.ts:29) or the member row is gone (identity.ts:38). Reachable with zero adversary: an owner of their auto-created workspace calls organization.remove -> services/identity/src/index.ts:172 -> identity.service.ts:194 deletes every member row of that org, with no guard that it is the caller's last organisation. Next request: apps/web/src/app/(dashboard)/layout.tsx:24 redirects to /sign-in; sign-in succeeds (the session.create hook at auth.ts:111-116 finds no membership and writes activeOrganizationId: null), returns to /projects, redirects again — a loop for a correctly authenticated user. Nothing repairs it in-product: /onboarding calls trpc organization.create, which dispatch() refuses at gateway.ts:125 (identify() null -> UNAUTHORIZED); even if it got past that, registry.ts:84-91 gates organization:create at owner with consumes:true and limits.free: false, so an org-less caller can never reach it.

Fixpackages/auth/src/identity.ts: when the session exists but the active org is unusable, re-resolve to the caller's earliest remaining membership using the same ordering as auth.ts:114 (asc(createdAt), asc(id)) and return that; when there are genuinely zero memberships return a distinct no-org identity instead of null. apps/web/src/app/(dashboard)/layout.tsx:24: send the no-org case to /onboarding, not /sign-in. Give the bootstrap a route the block allows: either declare it in packages/registry/src/registry.ts as an operation the gateway may run with an empty orgId (gateway.ts:129 already has the NO_ACTIVE_ORG branch) or recreate the workspace in identify() with the same slugify/workspaceName helpers the signup hook uses. Separately, add a last-organisation guard in services/identity/src/index.ts:172 mirroring assertNotTheLastOwner (index.ts:29) so the state is harder to enter.

NoteReproduced end to end against the real code. Line corrected from 28 to 29 (the null-org return). The organization.delete handler has no last-org guard, which is what makes it self-inflictable, and the free-plan limit false on organization.create closes the only nominal escape.

high
No index on member(organization_id) or (user_id, organization_id) — every authenticated request sequentially scans member
Auth
packages/auth/src/schema.ts:71 · reported by 2 auditors (database-data)
AlsoNothing enforces one membership per (user_id, organization_id) — duplicate member rows double-count seats and survive removal

Whenmember has no unique constraint on (user_id, organization_id) in either schema copy, and no insert path checks for an existing row: packages/auth/src/auth.ts:96-101 inserts a member on user create, identityService.createOrganization:166 inserts one, and Better Auth's organization plugin inserts one on invitation acceptance. A user who is invited to an org they already belong to (member.create only dedupes against *pending invitations*, services/identity/src/index.ts:61-64, not against existing members) and accepts gets a second member row. Consequences: countSeats (identity.service.ts:35) counts them twice so the org burns two seats against its plan limit for one person; identityService.removeMember deletes by member id so removing them leaves the duplicate behind and they retain access; and membershipOf/identify use .limit(1) with no ORDER BY, so which of two possibly-different roles the gateway grants is chosen by Postgres and can differ between requests — a user demoted to member can still be served owner from the stale duplicate row.

FixAdd uniqueIndex('member_user_org_idx').on(table.userId, table.organizationId) to the member table in packages/auth/src/schema.ts (this is the same index the member-indexing finding needs, so it costs nothing extra), and in the member.create handler at services/identity/src/index.ts:61 also check identityService.membershipOf({ organizationId: ctx.orgId, userId }) before creating the invitation.

high
billing.track swallows every error, so the meter consumer acks a usage unit it never metered
Billing
packages/billing/src/autumn.adapter.ts:89 · reported by 3 auditors (nats-jetstream-reliability, plan-gating-billing, ops-observability-config)
AlsoMetering failures are swallowed and acked — usage silently stops counting and every cap becomes infinite  ·  Metering failures are swallowed and the message is acked: an Autumn outage loses billable usage forever

Whenpackages/billing/src/autumn.adapter.ts:83-91 wraps autumn.track in try/catch and only logs. Combined with the container-result behaviour (finding 2) the catch is dead code: an Autumn 401/429/500 returns {data:null,error} from instance.post, track returns normally, services/billing/src/index.ts:76 awaits it without error, and packages/transport/src/serve.ts:87 acks the message. The evt is consumed and gone. If Autumn rejects writes for an hour (expired key, rate limit, outage), every create in that hour is unmetered permanently — usage under-reports forever and every plan cap silently rises for the affected orgs. No dead letter, no retry, no metric.

Fixpackages/billing/src/autumn.adapter.ts — in track (and setUsage), check the returned container and throw on error !== null; delete the try/catch so the throw propagates. packages/transport/src/serve.ts:88-91 already naks with 2s backoff and consume() is configured max_deliver: 5 (line 71), so a transient Autumn failure is retried and a persistent one lands on the stream's dead letter where it is visible instead of vanishing.

NoteConfirmed end to end: adapter catch, service await at index.ts:76, ack at serve.ts:87, nak/max_deliver at serve.ts:71/91. Fix must land together with finding 2 or the throw never happens.

high
pg Pool has no 'error' listener, so a Postgres failover or idle-client termination kills the service process
Data
packages/db/src/index.ts:24 · reported by 4 auditors (database-data, rate-limiting-abuse, ops-observability-config)
AlsoPool hard-coded to max 10 with no connection/idle/statement timeouts and no application_name  ·  pg pool has no connection or statement timeout, so saturation queues forever  ·  pg Pool has no 'error' listener: a Postgres failover or idle-connection kill crashes every service

WhenConfirmed: poolFor builds new Pool({ connectionString: url, max: 10 }) at line 24 and returns it at 26 with no listener of any kind; grep for .on( in packages/db/src returns nothing. node-postgres re-emits a backend error on an idle client as a Pool-level 'error' event, and Node's EventEmitter throws an unhandled 'error' as an uncaught exception. An RDS failover, a pg_terminate_backend, a maintenance restart or an idle-timeout proxy therefore takes down services/identity, services/projects or services/audit. The four service package.json start scripts are bare tsx src/index.ts with no supervisor, and infra/docker-compose.yml contains only nats/postgres/redis/redis-http — no service entries and no restart policy — so nothing brings the process back. For services/audit the running consume() loop (packages/transport/src/serve.ts:84) dies mid-iteration and in-flight evt.> messages redeliver against a dead consumer until max_deliver burns them.

FixIn packages/db/src/index.ts, between lines 24 and 25, add pool.on('error', (error) => console.error('[db] idle client error', error));. The pool already discards the broken client; the listener only prevents process death.

NoteConfirmed both the missing listener and the missing supervisor (compose file read in full). Severity high stands.

high
AUTUMN_SECRET_KEY is optional in production, so a deploy without it silently puts every org on the free plan and meters nothing
Config
packages/env/src/index.ts:71
Whenpackages/env/src/index.ts:71 is autumnSecretKey: () => optional("AUTUMN_SECRET_KEY"), returning null. packages/billing/src/autumn.adapter.ts:29 then sets autumn = null, so getEntitlements returns FALLBACK (free) for everyone (line 64), track returns without metering (line 82), setUsage no-ops (line 101), checkout returns {url:null} (line 119) and ensureCustomer no-ops (line 135). Ship to production with the variable missing from the secret store and the platform boots green, health checks pass, every customer is served the free plan, every paying customer is refused at the plan gate, and nobody is billed. Contrast natsNkeySeed twelve lines above (packages/env/src/index.ts:59-65), which deliberately throws when NODE_ENV is production for exactly this reason.

Fixpackages/env/src/index.ts:71 — replace the one-liner with the same shape as natsNkeySeed: read optional("AUTUMN_SECRET_KEY"), throw new Error("Missing AUTUMN_SECRET_KEY. Billing is the plan gate; see packages/billing/src/autumn.adapter.ts.") when it is null and process.env["NODE_ENV"] === "production", otherwise return null. Keep the FALLBACK path in the adapter for local/dev, and update the adapter's NOTE header (lines 8-9) to say the degrade is dev-only.

NoteConfirmed; the file itself contains the pattern to copy twelve lines up. Deployment-conditional but the condition (production without the secret) is exactly what the NATS check already guards against, so it is a real gap, not a hypothetical.

high
No per-IP or global limit anywhere; the IP is collected and then thrown away
The block
packages/guardrail/src/gateway.ts:103
WhenConfirmed literally: readonly ip: string at gateway.ts:103 is the ONLY occurrence of ip in the file - grep finds no read of args.ip anywhere in dispatch. apps/web/src/gateway/init.ts:39 resolves it from x-forwarded-for with a fallback of 'unknown' and it dies there. Consequences: no per-IP limit and no global backpressure valve. An attacker holding sessions in 500 throwaway orgs - each free to mint at sign-up via the databaseHook at packages/auth/src/auth.ts:85, and sign-up is itself unbounded per the X-Forwarded-For finding - gets 500x the per-org budget from one host, and nothing caps total in-flight requests per replica, so the process dies from queueing long before any per-org counter trips.

FixIn packages/guardrail/src/gateway.ts step 5 (line 166) add a second rateLimit call keyed ip:${args.ip} with a coarse ceiling, and a third keyed global:${resource} as a backpressure valve. Fix the source first: apps/web/src/gateway/init.ts:39 takes the leftmost x-forwarded-for value, which is fully attacker-controlled and falls back to 'unknown' (bucketing every unresolvable client together) - resolve it against a trusted-proxy list, and refuse rather than default when it cannot be resolved.

NoteThe dead-field claim is exact. High retained: this is the missing outer ring that makes the per-org limiter bypassable by tenant fan-out.

high
The limiter sits behind the identity and permission gates, so every refused request is free
The block
packages/guardrail/src/gateway.ts:124 · reported by 2 auditors (gateway-http-web, rate-limiting-abuse)
WhenGate order in dispatch is: 1 identify (:124), 2 org scoping (:131), 3 role (:136), 4 permission (:144), 4b escalation (:155), and only then 5 rate limit (:166). Every request that fails gates 1-4b is therefore never metered. Two concrete abuses. (a) No credential at all: apps/web/src/proxy.ts:32 checks only request.cookies.has(name), so a forged better-auth.session_token=garbage cookie reaches /api/trpc; dispatch calls identify (packages/auth/src/identity.ts:25) which calls auth.api.getSession - the cookie cache signature fails, so it falls through to a database session lookup - then fails at :124 with UNAUTHORIZED having spent a DB query and consumed nothing from any bucket. Combined with the missing batch cap, one HTTP request can force thousands of those. (b) A legitimate member-role user loops project.create: gate 3 refuses at :136, before the limiter, so an authenticated low-privilege user can generate unlimited getSession + member SELECT load forever and appear in no counter.

FixIn packages/guardrail/src/gateway.ts, add a cheap pre-identity limit as the new step 0, keyed on args.ip (currently dead, see the unused-ip finding) plus a session-cookie fingerprint, before deps.identify at line 124, and move a coarse per-identity limit ahead of the role/permission gates so refusals are metered too. Keep the existing per-org per-operation limit where it is for the success path.

high
Rate limit key is per-org only: one member starves the tenant, and limits ignore seat count
The block
packages/guardrail/src/gateway.ts:166
WhenConfirmed at gateway.ts:166-170: key: org:${identity.orgId}:${resource}:${operation}``, max/windowSeconds read straight from definition.rateLimit, which is a flat constant in packages/registry/src/registry.ts (project 60/60s at :187, member 30/60s at :240, organization 10/60s at :111, billing 5/60s at :142). (a) One member with a runaway client or a stolen session consumes the entire tenant's budget and every other member of that org gets RATE_LIMITED, with nothing in the key to attribute it. (b) There is no plan or seat dimension, so a 200-seat Scale org gets the same 60 project.read/min as a 1-seat free org - roughly 20 people browsing normally exhaust it, and paying customers see 429s during ordinary use. Note the buckets are per (resource, operation), so a single org can legitimately issue the sum of all buckets, but there is no aggregate cap at all.

FixIn packages/guardrail/src/gateway.ts step 5 (line 166) issue two rateLimit calls and refuse on either: the existing org key plus user:${identity.userId}:${resource}:${operation} at a fraction of max. For (b) widen the rateLimit declaration in packages/registry/src/registry.ts and its type in packages/registry/src/define.ts so it can be per-plan ({ free: {max,windowSeconds}, pro: ..., scale: ... }) and select on entitlements.plan - but note entitlements are fetched at step 6, after the limiter, so the fetch would need to move above step 5 or the plan be read from a cheaper source.

NoteLine corrected from 167 to 166 (the deps.rateLimit call). High retained: (b) alone breaks ordinary use for any multi-seat paying tenant, which is a production-breaking defect rather than a tuning preference. The fix needs the ordering caveat the auditor missed - plan is not known at step 5 today.

high
Plan limits are checked against a 30s-stale, asynchronously-metered snapshot and re-checked nowhere — a free org can create far past its limit
The block
packages/guardrail/src/gateway.ts:180
WhenThe only limit check in the platform is gateway.ts:180-186, and its input is deps.entitlements(orgId), which is cached for 30s (deps.ts:22-23) and populated from Autumn, which is itself only updated *after* the fact by the evt.> meter (services/billing/src/index.ts:71-77). No service re-checks: project.handlers.ts:29 says "the plan limit was already refused at the gateway", and projectService.countActive (project.service.ts:49) — the one authoritative count that exists — has no caller anywhere in the repo. So a free-plan admin (project limit 2, rate limit 60/min at registry.ts:187) who fires 20 project.create calls in the same second has every one of them see the same cached usage and be allowed; the meter catches up 20 projects later. The same holds for member.create seats and organization.create. This is not a race window of milliseconds — it is the full 30s TTL plus Autumn's own propagation delay, repeatable indefinitely by waiting out the window.

FixAdd an authoritative post-check in the owning service, where the count is a local query and ctx.plan is on the signed envelope. In services/projects/src/project.handlers.ts create, compare projectService.countActive(ctx.orgId) against limitFor("project", ctx.plan) (both already exist; limitFor is exported from packages/registry/src/derive.ts:247) and throw ServiceError("UPGRADE_REQUIRED", ...) — the decision stays derived from the registry rather than hand-written, so it cannot drift from the gateway's. Mirror it in services/identity/src/index.ts member.create with countSeats. The gateway check stays as the fast, user-facing refusal.

high
Plan gate never runs for any operation whose rule has consumes:false (auditLog.read)
The block
packages/guardrail/src/gateway.ts:181 · reported by 3 auditors (gateway-http-web, multitenancy-authz, plan-gating-billing)
AlsoThe auditLog plan gate is never enforced at the gateway — a free-plan admin can read the whole audit trail through tRPC  ·  Plan inclusion is never enforced for non-consuming operations — the audit log is a paid feature any free org can read over tRPC

Whenpackages/guardrail/src/gateway.ts:181 runs checkResourceAccess only if (rule.consumes). auditLog.read is consumes: false (packages/registry/src/registry.ts:313) while auditLog.limits.free is false (line 318) — not in the free plan at all. The route exists: apps/web/src/gateway/routers/billing.router.ts:35 exposes audit.list as gatewayQuery("auditLog", "read"). The dashboard layout blocks only the /audit *page* via navAccess().locked (apps/web/src/app/(dashboard)/layout.tsx:34), and the page itself says so in its own comment (apps/web/src/app/(dashboard)/audit/page.tsx:6-9, "Nothing here checks for that"). A free-plan admin calling api.audit.list.query({limit:100}) from the browser console on any dashboard page gets the full audit trail. Paid feature, served to non-payers, through the endpoint the whole architecture routes through.

FixDo NOT apply checkResourceAccess unconditionally as originally proposed — that would break free orgs entirely, because organization.limits.free is also false (registry.ts:110) and organization.read/update/delete are all consumes: false; every free org would be refused reading its own tenant. Instead: (1) packages/registry/src/registry.ts:110 — change organization's free limit from false to 0, which is "included, quota zero" rather than "not in the plan" and keeps organization.create refusing with the same upgrade copy via the limit_reached branch; then (2) packages/guardrail/src/gateway.ts:181 — always call checkResourceAccess, refuse on decision.reason === "not_in_plan" for every operation, and apply the limit_reached branch only when rule.consumes. checkResourceAccess (packages/registry/src/derive.ts:273-281) already returns the two reasons separately.

NoteDefect confirmed and reproduced. The original FIX was wrong and would have caused a worse outage (free orgs locked out of organization.read); corrected above with the registry change that makes it safe.

high
Every reply carrying a z.date() field fails contract.output.parse at the gateway - the wire form and the schema disagree
The block
packages/guardrail/src/gateway.ts:273
WhenThe bus codec is plain JSON (packages/transport/src/connection.ts:68-71), so a Date in a reply body crosses as an ISO string. The service parses its own output with real Date objects and passes (service.ts:86), signs the reply over contentHash(data) - which canonicalises the Date to the same ISO string the wire carries, so the MAC is consistent on both sides and verification succeeds - and then the gateway runs contract.output.parse(reply.data) at line 273 against a string. I executed zod 4.4.3 from packages/contracts/node_modules: z.object({createdAt: z.date()}).safeParse(JSON.parse(JSON.stringify({createdAt: new Date()}))) fails with 'expected date, received string'. projectDto (project.contract.ts:19-20), the member DTO (identity.contract.ts:19), invitation expiresAt (identity.contract.ts:60), organization createdAt (organization.contract.ts:31) and audit createdAt (audit.contract.ts:25) all use z.date(), so project.list, member.list, organization.read and audit.list each throw a raw ZodError out of dispatch, which procedures.ts:27 rethrows as a 500 - every list page in the product. This belongs to this dimension because it is the same canonical-form-versus-wire-form asymmetry as the canonicalise/undefined defect, verified on the same signing path.

Fixpackages/contracts/src/resources/*.ts: replace z.date() in every output DTO with z.coerce.date(), which accepts both the service's Date and the wire's ISO string and leaves contentHash unchanged because canonicalise maps both to the same ISO string. Add the round-trip assertion from the missing-tests finding (JSON.parse(JSON.stringify(output)) must satisfy contract.output) to tests/envelope-signing.test.ts so this cannot regress.

high
No boot check that a service implements every operation the registry assigns it
The block
packages/guardrail/src/service.ts:144
WhenVerified: defineService maps over the handlers it is given (line 144-169) and validates each against ROUTES, and routes (line 171) is derived from bindings, i.e. from handlers. There is no reverse check for ROUTES.filter(r => r.owner === service). services/projects/src/index.ts:5 claims it 'screams at boot if the handler is missing'; it does not - main() iterates runtime.routes, so an unhandled operation is simply never subscribed. Sharper failure than stated: for an rpc operation the caller waits timeoutMs and gets SERVICE_UNAVAILABLE, but for a command operation the gateway publishes to cmd.* and returns {accepted:true, requestId} to the browser (packages/guardrail/src/gateway.ts:212-217) - the user is told the mutation succeeded, nothing ever consumes it, and the message ages out of the CMD stream after 7 days (derive.ts:335). Silent write loss with a success response, typecheck/Biome/guardrail all green.

Fixpackages/guardrail/src/service.ts, after bindings is built (line 169): compute ROUTES.filter(r => r.owner === service) and throw naming every route with no matching handler - Service 'projects' owns project.archive but declares no handler; nothing will subscribe to cmd.project.archive. That makes the claim in services/projects/src/index.ts:5 and README:170 true.

NoteConfirmed. Severity kept at high and the scenario upgraded: the command-transport case is a silently dropped mutation acknowledged as success, not just a timeout.

high
Replay/idempotency store has zero call sites; nothing in the request path dedups
The block
packages/guardrail/src/service.ts:232
WhenGrep across apps, packages, services confirms claimReplay/recallReply/rememberReply (apps/web/src/gateway/replay.ts:145,150,163) are referenced only by their own definitions. handle() goes signature (232) -> route (237) -> subject (247) -> freshness (256) -> authority (261) -> execute, with no dedup step. One captured, validly signed envelope therefore executes as many times as it is published: rpc.project.delete replays for the 5s its own signed deadline allows; cmd.member.create never expires at all (envelope.ts:316) and republishing it every 3 minutes clears JetStream's 2-minute duplicate_window (packages/transport/src/streams.ts:26). Separately, selectStore()'s production guard (replay.ts:126-133) never executes because nothing imports the module, so a production deploy with no Upstash boots silently believing dedup exists. The structural blocker the auditor names is real: replay.ts lives in apps/web, and packages/guardrail cannot import from a Next app, so the call site its own WHERE comment names (service.ts step 2b) is unreachable as the file stands.

FixMove apps/web/src/gateway/replay.ts to packages/guardrail/src/replay.ts and export it from @guardrail/guardrail. Add a claim option to defineService and call it in handle as step 2b, immediately after verifyRequest at line 232: key ${service}:${meta.resource}.${meta.operation}:${meta.requestId}, ttl deadlineAt - now + CLOCK_SKEW_MS for rpc and STREAMS' CMD maxAgeDays for commands; duplicate -> CONFLICT for rpc, recalled reply for commands; unavailable -> fail closed for mutations and all commands, fail open for queries. Add UPSTASH_* to each service's env.

NoteConfirmed exactly as described, including that nothing imports the module. Severity corrected critical -> high: infra/nats/auth.conf:26 gives publish rights on rpc.* and cmd.* to the gateway nkey alone, so replay requires that credential or host access, and infra/nats/RUNBOOK.md:146-158 documents the gap as gr-017 with today's date. It is still high because the only bound on repetition is a credential, not a control, and the store that was written to fix it is inert.

high
A JetStream publish failure after a committed mutation turns a successful write into an INTERNAL error
The block
packages/guardrail/src/service.ts:282 · reported by 2 auditors (nats-jetstream-reliability, ops-observability-config)
Whenawait publishEvent(...) at line 282 sits inside the same try that wraps binding.entry.execute at line 274, and the catch at line 303 maps any non-ServiceError to reject(meta, "INTERNAL", ...). Sequence: rpc.project.create commits the row; the EVT stream is momentarily unavailable (leader election, or the 10GB max_file_store in infra/nats/nats.conf:23 reached); publishEvent throws; the gateway sees INTERNAL and the customer retries, creating a duplicate project. The audit_log gets no row for a mutation that actually happened - in a table the registry (registry.ts:305) advertises as the 'immutable record of every mutation' - and billing never meters it. On the one command path (cmd.member.create) the throw makes services/identity/src/index.ts:217 rethrow, the message is nak'd and the handler re-runs.

FixIn packages/guardrail/src/service.ts move the if (binding.route.event !== null) block out of the handler try (or give it its own try that logs and continues) so the signed success reply is still returned, and persist undelivered events to a per-service outbox table for retry rather than failing the customer's request.

NoteLine numbers exact (publish 280-286, catch 303-309). The duplicate-project half of the scenario holds because project.create is rpc with no idempotency store wired (apps/web/src/gateway/replay.ts exists but nothing imports it).

high
Usage only ever grows: deletes never decrement, so an org that deletes everything stays permanently at its cap
Registry
packages/registry/src/registry.ts:177
Whenproject.delete is consumes: false (packages/registry/src/registry.ts:177-184), billing.track only ever adds args.value ?? 1 (packages/billing/src/autumn.adapter.ts:87), the meter only fires for consumes operations (services/billing/src/index.ts:75), and the delete is a hard row delete (services/projects/src/project.service.ts:98-103). A free org creates 2 projects, deletes both: 0 rows in the table, usage.project === 2, limit === 2. Every further create is refused with "You have used every project on your plan", and the customer's only remedy is to buy a plan they do not need. Identical shape for member/seats (member.delete consumes false, registry.ts:230) and organization (organization.delete consumes false, registry.ts:101).

FixPrefer the absolute-count route over a signed decrement, because a decrement has the same double-delivery problem as finding 8. Have each owning service publish its authoritative count after a mutation — services/projects/src/project.handlers.ts can call the existing projectService.countActive (project.service.ts:49) — and have services/billing/src/index.ts call billing.setUsage with that count instead of track. That requires fixing setUsage first (next finding), since it currently increments. If you take the decrement route instead, add a releases: boolean to OperationRule in packages/registry/src/define.ts:66-79, set it on the delete operations, and call billing.track({ value: -1 }) from the meter.

NoteConfirmed across all four files. Severity high is right: it is a hard, permanent lockout of a paying-eligible customer produced by normal product use, and there is no in-product remedy.

high
connection() memoises a rejected or closed connection promise for the life of the process
Bus
packages/transport/src/connection.ts:41 · reported by 2 auditors (nats-jetstream-reliability, ops-observability-config)
AlsoA failed first NATS connect is cached forever, permanently bricking the gateway process

WhenglobalThis.__guardrailNats ??= connect({...}) stores the promise. If the first connect rejects (gateway container starts before NATS is reachable, DNS blip, Authorization Violation from a stale auth.conf, or the 2s authorization.timeout in infra/nats/nats.conf:29 firing), the rejected promise is retained for the process lifetime: every later rpcRequest/publishCommand/js()/jsm() awaits the same rejection, so the Next.js gateway returns SERVICE_UNAVAILABLE to 100% of traffic even after NATS recovers. maxReconnectAttempts: -1 (line 45) only applies after a connection has been established. Compounding it, closeConnection() at line 65 does await (await pending).drain() on that same rejected promise, so the SIGTERM handler in services/*/src/index.ts:53 rejects and process.exit(0) never runs.

FixIn packages/transport/src/connection.ts wrap the stored promise: const p = connect({...}).catch((e) => { globalThis.__guardrailNats = undefined; throw e; }); globalThis.__guardrailNats = p; so a failed connect is evicted and the next call retries, guard closeConnection with a try/catch, and add a for await (const s of nc.status()) logger so reconnect/disconnect flapping is visible.

NoteConfirmed at the exact line. Added the closeConnection consequence, which the original finding missed.

high
Poison/transient command is terminated in ~10s with no dead-letter and no advisory subscriber
Bus
packages/transport/src/serve.ts:71
Whenmax_deliver:5 (serve.ts:71) with a fixed message.nak(2000) (serve.ts:91) gives every command exactly 5 attempts inside ~10s. Postgres fails over for 15s while cmd.member.create is in flight: identity's handler returns an INTERNAL reject, services/identity/src/index.ts:217 throws, all 5 deliveries burn, JetStream terminates the message. The gateway already returned {accepted:true, requestId} (gateway.ts:217) so the browser shows the invitation as sent. It is gone permanently.

Fixpackages/transport/src/serve.ts: add backoff: [1e9, 5e9, 30e9, 120e9, 600e9, 1800e9] (ns) plus a matching max_deliver: 6 to the consumer config so the retry horizon spans ~40 minutes instead of 10 seconds, and stop passing a constant delay to message.nak() (let the consumer backoff drive it). Add one consume()/subscription bound to $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.> in services/audit/src/index.ts (and the matching subscribe allow in infra/nats/generate-auth.ts) so a terminated command is at least recorded. Fix the comment at serve.ts:90.

NoteVerified: max_deliver 5, nak(2000), no dead-letter concept in JetStream, and grep -ri 'JS.EVENT|ADVISORY|max_deliveries' across the repo (excluding node_modules) returns nothing. Severity lowered from critical to high: the loss is one accepted user action per incident, not stored-data corruption, and it needs a >10s dependency outage. The comment at serve.ts:90 is factually wrong as stated.

high
consume() is voided at all four call sites and its loop can end silently, stopping audit and metering while the process stays alive
Bus
packages/transport/src/serve.ts:82 · reported by 2 auditors (nats-jetstream-reliability)
Alsoconsume() prefetches 100 messages while handling them one at a time, so ack_wait expires on the buffer tail

Whenconsumer.consume() is called with no options. parseOptions in node_modules/.pnpm/@nats-io+jetstream@3.4.0/.../lib/consumer.js:618-625 defaults max_messages to 100 and (refilling) threshold_messages to 75, so the server marks 100 messages delivered and starts a 30s ack_wait timer (serve.ts:72) on each, while serve.ts:84-93 awaits the handler strictly serially. billing's meter calls Autumn over the network: at ~400ms per track(), message 76 of the batch is acked at ~30s and everything after it has already been redelivered. The redeliveries are handled again - double-metering every affected org - and each one burns a delivery against max_deliver:5, so a sustained burst terminates events outright. max_ack_pending is not set either, so the server default (1000) does not bound it.

Fixpackages/transport/src/serve.ts:82: call consumer.consume({ max_messages: 5 }) so the in-flight window is small enough that 5 x p99 handler latency stays well inside ack_wait, and set an explicit max_ack_pending: 5 in the consumer config at serve.ts:67-73 so the server enforces the same bound. If throughput matters more than ordering, keep the buffer but process with bounded concurrency and raise ack_wait accordingly - the two numbers must be chosen together, which is the point of putting them in the same object.

high
Commands and events that fail five times are dropped silently - no dead-letter stream, no advisory consumer
Bus
packages/transport/src/serve.ts:90 · reported by 2 auditors (crypto-envelope-replay, ops-observability-config)
WhenThe comment at line 90 claims 'after max_deliver it lands on the stream's dead letter', but STREAMS in packages/registry/src/derive.ts:328 declares only CMD and EVT and nothing subscribes to $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>. Worse than the finding states: max_deliver: 5 (line 71) combined with the fixed message.nak(2000) at line 91 means the total retry window is roughly 10 seconds. A Postgres failover lasting 15s therefore exhausts delivery for the audit-trail consumer (services/audit/src/index.ts:51) and every audited mutation in that window is permanently absent from the compliance trail, with one console.error line and no alert. The same 10s window applies to billing-meter and to cmd.member.create, where the gateway has already answered {accepted: true}.

FixIn packages/transport/src/serve.ts replace the fixed nak with exponential backoff (message.nak(Math.min(2 ** deliveryCount * 1000, 60_000)) from message.info.redeliveryCount) and raise max_deliver, add a DLQ stream to STREAMS in packages/registry/src/derive.ts sourced from $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>, and add a consumer that persists the dropped stream sequence so a redrive is possible.

NoteConfirmed, and sharpened: the real exposure is the ~10s total retry budget (5 x 2s fixed nak), which is shorter than any realistic database failover.

high
EVT/CMD streams have no size limit, and publishEvent inside the success path turns a committed mutation into INTERNAL
Bus
packages/transport/src/streams.ts:20
WhenBoth halves confirmed. streams.ts:20-27 builds the stream config with name/subjects/description/max_age/duplicate_window only - no max_bytes, no max_msgs, no discard policy - while infra/nats/nats.conf:22 caps JetStream globally at max_file_store 10GB. When EVT reaches the account limit JetStream rejects publishes. In packages/guardrail/src/service.ts:275-286 publishEvent is awaited INSIDE the same try that wraps the handler, after binding.entry.execute has already committed to Postgres, and the catch at :301-307 maps any throw to a signed INTERNAL reject. So the project row exists, the caller sees a failure, and no audit row and no metering event is ever written for it. The auditor's 'retries and creates a duplicate' is imprecise for projects: project.handlers.ts:31 checks the slug, so a same-slug retry returns CONFLICT - confusing rather than duplicating - but organization.create and any future non-unique resource would duplicate.

FixAdd maxBytes to StreamConfig in packages/registry/src/derive.ts:321-341 and set max_bytes plus discard: 'old' in the config object at packages/transport/src/streams.ts:20 so the stream self-trims instead of failing publishes. Separately, in packages/guardrail/src/service.ts wrap the publishEvent call at :282 in its own try/catch that logs and still returns the success reply, so a bus problem cannot make a committed mutation look failed.

NoteBoth claims reproduced. Title sharpened - the service.ts half is the more damaging one and is independent of the stream sizing. Scenario correction noted for the duplicate claim.

high
<Gate> defaults fallback to null, cancelling FeatureGate/PriceGate's documented UpgradePrompt default
Client mirror
packages/ui/src/components/gate.tsx:24
WhenVerified: gate.tsx:24 fallback = null is forwarded to FeatureGate (line 36) and PriceGate (line 37); both decide with fallback === undefined ? <UpgradePrompt/> : fallback (feature-gate.tsx:45, price-gate.tsx:42). Through <Gate> the value is never undefined, so the documented default is unreachable. A free org at 2/2 projects rendering the SKILL.md example <Gate resource="project" operation="create">…</Gate> with no fallback gets an empty header: no button, no upsell, no explanation.

Fixpackages/ui/src/components/gate.tsx: drop the default (fallback?: React.ReactNode) and forward conditionally — const slot = fallback === undefined ? {} : { fallback }; then <FeatureGate resource={resource} {...slot}><PriceGate resource={resource} {...slot}>. This spread form is required by exactOptionalPropertyTypes (tsconfig.base.json). Then reduce project-list.tsx:50-54 to a bare <Gate resource="project" operation="create">.

NoteSeverity lowered from critical to high: no live call site is broken today. The only <Gate> user, apps/web/src/features/projects/project-list.tsx:53, hand-builds access.decision.allowed ? null : <UpgradePrompt/>, so the /projects upsell does render. The defect is in the shared primitive and bites the next feature that follows SKILL.md verbatim — which for a boilerplate whose deliverable is the primitive is still serious.

high
Usage is metered on create and never decremented on delete — plan limits become lifetime caps
Billing
services/billing/src/index.ts:76 · reported by 6 auditors (crypto-envelope-replay, multitenancy-authz, nats-jetstream-reliability, plan-gating-billing, auth-session-identity)
AlsoThe billing meter increments with no idempotency, unlike the audit consumer — one redelivery double-charges a tenant's quota  ·  Metering increments a counter in a consumer with no dedupe key, so at-least-once delivery over-bills  ·  Metering has no idempotency key, so an at-least-once evt redelivery double-charges the customer  ·  Seat usage only ever increases: metered on invitation, never on acceptance, never decremented on removal

WhenThe billing-meter durable consumer (services/billing/src/index.ts:67-78) acks only after billing.track resolves (packages/transport/src/serve.ts:86-87). If the billing process is killed mid-handler, or ack_wait (30s, serve.ts:72) elapses because Autumn is slow, JetStream redelivers the same evt.project.create up to max_deliver 5 (serve.ts:71) and track increments the projects feature again each time — one project creation metered as up to five. The publish-side msgID dedupe (packages/transport/src/request.ts:117, ${requestId}:evt) protects only against duplicate *publishes*, not against redelivery to the consumer. The audit consumer is protected by a unique requestId with onConflictDoNothing (services/audit/src/audit.service.ts:32); the meter has no equivalent. For a usage-priced feature that is a direct overcharge; for a capped feature it locks a customer out below their real count.

Fixpackages/billing/src/autumn.adapter.ts — add requestId: string to the track argument object and pass idempotency_key: args.requestId to autumn.track. Verified supported: TrackParamsSchema declares idempotency_key: z.ZodOptional<z.ZodString> (autumn-js dist/sdk/index.d.ts:536, dist/sdk/index.js:1450). Thread it from services/billing/src/index.ts:76 as requestId: meta.requestId, which the consumer already has in scope.

NoteConfirmed including the SDK field. Note the publish-side msgID dedupe does not help here — worth saying in the fix so nobody assumes it does.

high
deleteOrganization deletes only identity rows; project rows, audit rows and the Autumn customer outlive the tenant
Identity
services/identity/src/identity.service.ts:194
WhenConfirmed. The transaction at 195-203 deletes invitation, member, organization and nothing else. services/projects/src/schema.ts:8 states referential integrity across services 'is enforced by events (evt.organization.deleted)' — I grepped every .ts under services/, apps/ and packages/: the only consume( calls are services/audit/src/index.ts:49 (filter evt.>, writes audit rows), services/billing/src/index.ts:67 (filter evt.>, meters), services/identity/src/index.ts:211 and services/projects/src/index.ts:33 (both CMD-stream command routes). No consumer deletes anything, and the subject the comment names does not exist (the registry generates evt.organization.delete, not .deleted). So after an owner deletes their org, every project row and every audit_log row for that organization_id is orphaned: unreachable by any product query (all are scoped by ctx.orgId, and no member row remains to produce that orgId) and therefore invisible to a GDPR erasure. packages/billing/src/autumn.adapter.ts has ensureCustomer/checkout/track/setUsage and no delete or cancel, so the Autumn customer keyed on the dead org id keeps its subscription.

FixAdd a defineConsumer in services/projects/src/index.ts on filterSubject 'evt.organization.delete' that runs db.delete(project).where(eq(project.organizationId, meta.orgId)) (idempotent, at-least-once safe), the same in services/audit/src/index.ts subject to retention policy, and a cancel(organizationId) in packages/billing/src/autumn.adapter.ts invoked from a branch in services/billing/src/index.ts. Then fix the false comment at services/projects/src/schema.ts:8.

NoteRaised medium -> high: this is unbounded orphaned customer data with no erasure path plus continued invoicing of a deleted tenant, and the code comment asserting the mechanism exists is factually false, so no operator will look for it.

high
Invitations are never delivered and cannot be accepted anywhere in the product
Identity
services/identity/src/index.ts:53
Whenmember.create is handled by the identity service (index.ts:53-74), which writes the invitation row directly via identityService.createInvitation (identity.service.ts:59), so Better Auth's sendInvitationEmail (auth.ts:127, itself only a console.info stub) is never invoked — it only fires on /organization/invite-member, which superseded.ts:65 refuses with 410. The comment at index.ts:72 promises 'a notifier consumes evt.member.create', but services/ contains only audit, billing, identity and projects, and the only evt.> consumers are the audit trail and the billing meter (services/billing/src/index.ts:70). grep across apps/web for acceptInvitation or an invitation id returns nothing — there is no /invite route and no accept UI. So an owner clicks Invite, sees 'Invitation accepted. It sends shortly.' (apps/web/src/features/team/member-list.tsx:114), a seat is metered (registry.ts member.create consumes:true), and the invitee receives nothing and has no URL to accept; the row expires 48h later (identity.service.ts:73). Team growth — the thing seats are priced on — does not work.

FixAdd services/notifier built with defineConsumer on evt.member.create (mirror services/audit/src/index.ts:52) that sends the mail, and add apps/web/src/app/invite/[invitationId]/page.tsx calling authClient.organization.acceptInvitation (already exported from packages/auth/src/client.ts:30). Keep delivery out of the identity handler so the vendor boundary holds; if you prefer one hop, do it in services/identity/src/index.ts:65 right after createInvitation.

NoteConfirmed; anchor moved from identity.service.ts:59 to the handler at services/identity/src/index.ts:53, which is where the delivery step is missing. Note the KEPT accept-invitation endpoint is the only accept path and it is not reachable from any UI.

high
member.delete has no last-owner guard, so the only owner of an organisation can be removed
Identity
services/identity/src/index.ts:76 · reported by 2 auditors (database-data, multitenancy-authz)
Alsomember.delete has no last-owner protection — an owner can delete the last owner, leaving an unadministrable tenant

WhenVerified against the code: handlerFor("member","delete") (index.ts:76-86) calls identityService.removeMember directly with no role lookup and no assertNotTheLastOwner. assertNotTheLastOwner exists at :29 and is called from member.update (:119) and membership.delete (:189) only. member-list.tsx:128-137 wraps the Remove button in <AccessGate resource="member" operation="delete">, which is true for an owner, and rows come from member.read unfiltered — so the owner's own row carries a Remove button. Gateway 4b (gateway.ts:150) sees {memberId} with no role key so refusedRole returns null; service 5b likewise. Result: zero owners. billing:manage, member:update, member:delete and organization:delete all have minRole owner, so no remaining principal can upgrade the plan, change a role or close the tenant — recovery requires direct SQL.

FixIn services/identity/src/index.ts inside handlerFor("member","delete"), do exactly what member.update does at :112-120: load the target with identityService.memberIn({organizationId: ctx.orgId, memberId: input.memberId}), throw NOT_FOUND if null, and if normalizeRole(target.role) === HIGHEST_ROLE await assertNotTheLastOwner(ctx.orgId) before removeMember. (Hiding the button in member-list.tsx is cosmetic, not the fix.)

NoteConfirmed exactly as described, including the inconsistency with the two paths that do check. Severity lowered from critical to high: there is no attacker path, no cross-tenant leak and no auth bypass — it needs the tenant's own owner to click their own Remove button. It is unrecoverable in-product and blocks upgrades (revenue), which is why it stays high and is the strongest finding in the set.

high
No deployment artifact for any process; services run only through tsx, a devDependency
Projects
services/projects/package.json:8
WhenAll four services declare "start": "tsx --conditions=react-server src/index.ts" (audit/billing/identity/projects package.json line 8) with tsx+typescript under devDependencies (projects line 26-27) and no build script anywhere, while turbo.json:14-17 declares build outputs dist/** that nothing produces. pnpm install --prod on a release image yields tsx: command not found; there is no Dockerfile, Procfile, systemd unit or k8s manifest in the tree (only infra/docker-compose.yml, which starts NATS/Postgres/Redis and no app process). turbo.json:23-26 start has no dependsOn: ["build"], so pnpm start for apps/web (next start) fails with 'no production build found' unless someone remembers pnpm build first.

FixAdd a build script (tsup/tsc to dist/) to each services/*/package.json so turbo.json's existing dist/** output is real, add a multi-stage services/<name>/Dockerfile that installs prod deps and runs node dist/index.js, add "dependsOn": ["build"] to the start task in turbo.json, and ship an infra/ manifest that runs the five app processes with a restart policy.

NoteVerified file-by-file. Severity lowered critical -> high: this blocks deployment and rollback, but it does not by itself lose data, leak tenants or bypass auth, which is what the critical band is reserved for here.

high
organization.delete deletes the tenant but nothing purges its rows in other services — the event-driven referential integrity has no consumer
Projects
services/projects/src/index.ts:23
WhenConfirmed. identity.service.ts:194-204 deletes invitation, member and organization in one transaction and service.ts:280-286 emits evt.organization.delete (organization.delete declares audit: true at registry.ts:106). The only defineConsumer call sites in the repo are services/audit/src/index.ts:53 and services/billing/src/index.ts:71, both on evt.>: audit *writes* a row for the deletion, and billing drops it (consumes false). services/projects/src/index.ts:23-45 registers serveRpc/consume for its own routes and nothing else. Every row in the projects project table for that orgId — name, slug, description, createdById — survives indefinitely, as do that tenant's audit_log rows, with no organisation to reach them through. identity.service.ts:189-193 states this is the outcome being prevented; it is not prevented.

FixAdd void consume({stream: "EVT", durable: "projects-org-purge", filterSubject: "evt.organization.delete", handler: defineConsumer({secret}, async ({meta}) => projectService.purgeOrganization(meta.orgId))}) in services/projects/src/index.ts main(), with purgeOrganization as a single db.delete(project).where(eq(project.organizationId, orgId)) in services/projects/src/project.service.ts. The projects NATS user currently has no EVT-stream or evt.organization.delete permission, so infra/nats/generate-auth.ts must be re-run to grant it (auth.conf:32-39). Decide explicitly whether audit_log is purged or retained, and write the decision down.

NoteConfirmed including the absence of any other consumer. Severity kept at high on the deployment condition the auditor stated (any deployment under a GDPR/DPA erasure obligation is non-compliant on the first tenant deletion); the pure engineering harm — unbounded dead rows — would be medium on its own. Note the fix is not complete without the auth.conf regeneration, which the original omitted.

high
No health or readiness endpoint on the gateway or any service
Projects
services/projects/src/index.ts:45
Whenmain() in all four services/*/src/index.ts only calls serveRpc/consume and returns; a repo-wide grep for createServer/listen(/healthz/readiness returns nothing, and apps/web/src/app/api contains only auth/ and trpc/. Two silent-death paths exist and neither is observable: (a) the for await (const message of messages) loop in packages/transport/src/serve.ts:84 returns normally when the connection drains or the consumer is deleted - and because services/audit/src/index.ts:49 and services/projects/src/index.ts:33 call void consume({...}), that resolution is discarded, so the process stays alive having logged '[audit] consuming evt.>' while consuming nothing; (b) the cached-rejection bug in connection.ts leaves the gateway answering SERVICE_UNAVAILABLE forever. In both cases the container is 'Running', an orchestrator keeps it in rotation, and a liveness probe on apps/web / returns 200 from a statically rendered page with NATS and Postgres both down.

FixAdd apps/web/src/app/api/health/route.ts that resolves connection() and returns 503 unless nc.isClosed() === false, and add a small node:http listener in each services/*/src/index.ts (port from a new healthPort() in packages/env/src/index.ts) that reports 200 only after every entry in runtime.routes is bound and the consume loop is still running - have packages/transport/src/serve.ts return a liveness handle rather than a promise that resolves on loop exit.

NoteFile and line correct (main() ends at 45). Strengthened: the silent-consumer path is worse than the finding states because void consume(...) discards both the rejection and the normal resolution.

high
Check-then-write across a network hop: no service enforces its own limit, so concurrent requests always overshoot
Projects
services/projects/src/project.handlers.ts:28
WhenThe comment at services/projects/src/project.handlers.ts:29 ("The plan limit was already refused at the gateway") is the whole enforcement. Two project.create requests for a free org at usage 1 arrive milliseconds apart; both pass the gateway gate (1+1 <= 2 twice), both reach the handler, both insert via projectService.create. The org ends at 3 on a limit of 2. Same for organization.create (services/identity/src/index.ts:141) and worse for member.create, which is transport: "command" (packages/registry/src/registry.ts:207-214): packages/guardrail/src/gateway.ts:217 returns accepted before the write happens at all, so there is no point at which anything counts.

Fixservices/projects/src/project.service.ts already has an unused countActive(organizationId) at line 49 — that is the missing half. In services/projects/src/project.handlers.ts:28 wrap the create in a db.transaction that takes a row lock on the org's projects (select count(*) ... for update inside the transaction), compares against limitFor("project", ctx.plan) from @guardrail/registry (ctx.plan already arrives in the signed envelope, packages/guardrail/src/service.ts:269) and throws new ServiceError("UPGRADE_REQUIRED", ...). Mirror it in services/identity/src/index.ts:141 for organisations and :53 for invitations. The gateway gate stays as the fast refusal; the service becomes the true cap.

NoteConfirmed. Sharpened: countActive already exists and is referenced nowhere in the repo (grep across apps/packages/services/tests/tools/scripts), so the fix is wiring, not new query code.

high
Plan usage is a monotonic Autumn meter never decremented on delete or archive; projectService.countActive is dead code
Projects
services/projects/src/project.service.ts:49
WhenConfirmed end to end. packages/guardrail/src/gateway.ts:182 calls checkResourceAccess({resource, entitlements}); derive.ts:266 reads entitlements.usage[resource], sourced from Autumn features[featureId].usage (packages/billing/src/autumn.adapter.ts:50-59). services/billing/src/index.ts:71-77 is the only writer and it early-returns unless ruleFor(...).consumes — registry.ts has project.create consumes:true (line ~166) and project.update/delete consumes:false (~178,~186); member.create consumes:true (~207), member.update/delete consumes:false (~223,~231). billing.track (autumn.adapter.ts:84) increments by 1; there is no decrement path anywhere. grep confirms projectService.countActive has exactly one definition and zero call sites (countSeats is called, countActive is not). Free plan, projects limit 2: create two, delete both, DB has 0 rows, Autumn usage is 2, gateway returns limit_reached forever and usageLabel renders '2 of 2'. Same for seats (free limit 2): churn one member and the org can never invite a replacement.

FixIn services/billing/src/index.ts, after the consumes check, add a reconciliation branch for evt.project.delete / evt.member.delete that calls billing.setUsage (already present, autumn.adapter.ts:95) with the authoritative count; expose that count by adding a usage rpc backed by projectService.countActive / identityService.countSeats. Cheapest correct alternative: keep the counter but make the owning service the source of truth on every mutation via setUsage, so create/delete/archive all converge.

NoteVerified every link in the chain including the dead countActive. Severity high is right: it is a hard product lock-out for the exact customers on the smallest plan, and the fix is not user-recoverable.

high
tools/guardrail-check.ts enumerates only Better Auth's organization plugin, so every other plugin's mounts are invisible to the completeness rule
Enforcement
tools/guardrail-check.ts:634
WhenmountedOrgEndpoints (tools/guardrail-check.ts:634-657) imports better-auth/plugins, calls organization() and reads that one plugin's .endpoints. everyEndpointHasAVerdict (line 753-772) then reports any of those paths missing from SUPERSEDED or KEPT. But packages/auth/src/auth.ts:121-135 mounts three plugins — organization, autumn and nextCookies — and the autumn plugin contributes fourteen unguarded mounts (/autumn/attach, /autumn/cancel, /autumn/track, /autumn/billing_portal, /autumn/customers, /autumn/checkout, /autumn/query, /autumn/entities and more, dist/libraries/backend/better-auth.js:2724-2830), every one with use: []. The check passes green while those doors are open, which is exactly how the finding above came to exist. Any future plugin (payments, SSO, passkeys) reopens the same class of hole with the check still passing. The file's own comment at line 761 says "the table is only as good as the list it is complete against" — the list is incomplete by construction.

Fixtools/guardrail-check.ts:634 — rename to mountedAuthEndpoints and enumerate every plugin actually mounted rather than one hard-coded factory: import the configured auth object through packages/auth/src/auth.ts and walk auth.options.plugins (or, if importing the instance is too heavy for a static check, parse the plugins: [...] array in auth.ts with the TypeScript AST helpers this file already uses, then instantiate each named factory the same way organization() is instantiated today). Collect .path from every endpoint of every plugin. Then add the autumn paths to SUPERSEDED/KEPT in apps/web/src/app/api/auth/superseded.ts so the check goes green honestly.

Medium — operational pain, or silent wrongness in an edge case · 81
medium
.env.example omits three variables the code reads and mislabels Upstash as optional
Repo
.env.example:25
Whenpackages/env/src/index.ts reads RATE_LIMIT_ALLOW_IN_MEMORY (line 81), SERVICE_NAME (lines 54, 77) and NODE_ENV (lines 61, 78); none appear in .env.example, whose header line 1 claims 'Every variable here is declared once in packages/env/src/index.ts'. Line 25 labels rate limiting '(optional: falls back to in-process)', but apps/web/src/gateway/ratelimit.ts:102 throws at module init when env.isProduction() and no Upstash config is present - and that module is imported by deps.ts, so a production gateway built from .env.example alone crashes on the first request path evaluation. apps/web/src/gateway/replay.ts:127 has the same throw and will fire the moment that module is wired into service.ts as its header says it should be.

FixAdd RATE_LIMIT_ALLOW_IN_MEMORY, SERVICE_NAME and NODE_ENV to .env.example with defaults, and move UPSTASH_REDIS_REST_URL/TOKEN into a 'required in production' section whose comment mirrors the two throws (ratelimit.ts:102, replay.ts:127).

NoteVerified line by line. Caveat: replay.ts is currently imported by nothing (grep shows no importer), so only the ratelimit.ts throw fires today.

medium
No security headers: no HSTS, CSP, X-Frame-Options or nosniff
Web app
apps/web/next.config.ts:3 · reported by 2 auditors (gateway-http-web, auth-session-identity)
AlsoNo security headers: the sign-in page can be framed and there is no CSP or HSTS

Whennext.config.ts contains only typedRoutes and transpilePackages (lines 3-13) — no headers() block anywhere in apps/web, so no Content-Security-Policy, Strict-Transport-Security, X-Frame-Options/frame-ancestors, Referrer-Policy or X-Content-Type-Options is served. /sign-in (apps/web/src/app/(auth)/sign-in/page.tsx) can be framed for a clickjacking or credential-overlay attack, an injected script in the dashboard has no CSP between it and /api/trpc, and a first plaintext request on a hostile network is not upgraded (the __Secure- cookie protects the token, not the page the password is typed into).

Fixapps/web/next.config.ts — add async headers() returning, for source '/(.*)': Content-Security-Policy with frame-ancestors 'none' and a nonce-based script-src, Strict-Transport-Security max-age=63072000; includeSubDomains; preload, Referrer-Policy strict-origin-when-cross-origin, X-Content-Type-Options nosniff.

NoteConfirmed by reading the whole file. Note CSRF is NOT part of this gap: Better Auth's default trustedOrigins is the configured baseURL and the session cookie is SameSite=lax, so cross-site POSTs are already refused.

medium
No <form> anywhere: Enter does nothing in sign-in, create-project or invite
Web app
apps/web/src/app/(auth)/sign-in/page.tsx:21
WhenVerified: sign-in/page.tsx:21 is a bare <main> holding two Inputs and a Button wired with onClick (line 31) — typing an email, tabbing, typing a password and pressing Enter does nothing. Same shape at project-list.tsx:55-68, member-list.tsx:78-104 and onboarding/page.tsx:43-52. Password managers key their save prompt off form submission, so credentials are never offered for saving. sign-in also has no pending flag (only error state at line 12), so the button double-clicks into two concurrent auth calls.

FixWrap each control group in <form onSubmit={(e) => { e.preventDefault(); … }}> with type="submit" buttons in apps/web/src/app/(auth)/sign-in/page.tsx, features/projects/project-list.tsx, features/team/member-list.tsx and app/onboarding/page.tsx; add autoComplete="email"/"current-password" and a useState pending flag disabling the sign-in button.

NoteConfirmed in all four files, including the missing pending state on sign-in. Medium is right — it is the first interaction every user has with the product.

medium
No sign-out and no sign-up anywhere in the UI
Web app
apps/web/src/app/(auth)/sign-in/page.tsx:31
Whenpackages/auth/src/client.ts:30 exports signOut and signUp and a grep shows neither is imported anywhere in apps/web. The sidebar (apps/web/src/components/sidebar.tsx) has nav items and a plan badge and nothing else, so a signed-in user has no way to end their session — on a shared machine the next person is inside the tenant, and proxy.ts only redirects when the session cookie is absent. There is also no registration route and no link to one from /sign-in, so a fresh deployment has no self-serve path to a first account.

FixAdd a client 'Sign out' control to apps/web/src/components/sidebar.tsx (or a small apps/web/src/components/account-menu.tsx) calling signOut from @guardrail/auth/client then router.push('/sign-in'), and add apps/web/src/app/(auth)/sign-up/page.tsx using signUp.email, linked from sign-in/page.tsx.

medium
Billing page ignores ?locked=, prints the raw plan key, and mounts a vendor widget with no boundary
Web app
apps/web/src/app/(dashboard)/billing/page.tsx:15
WhenVerified across the 37-line file: (1) the component takes no searchParams, so the layout.tsx:34 redirect to /billing?locked=auditLog lands on a generic page and the upsell intent is dropped; (2) line 15 renders overview.entitlements.plan — the internal key — producing "You are on the free plan" instead of "Free", and sidebar.tsx:22 puts the same key in a Badge, while PLANS[plan].label exists for exactly this (registry.ts:25-30); (3) no empty branch for overview.resources, and <PricingTable/> from autumn-js at line 34 has no Suspense or error boundary, so a vendor failure blanks the page every denied user is sent to.

Fixapps/web/src/app/(dashboard)/billing/page.tsx: accept searchParams, validate locked against RESOURCE_KEYS and render <UpgradePrompt decision={checkResourceAccess({resource, entitlements: overview.entitlements})}/> above the table; replace overview.entitlements.plan with PLANS[overview.entitlements.plan].label here and at apps/web/src/components/sidebar.tsx:22; add the empty-rows branch and wrap <PricingTable/> in Suspense plus the new (dashboard)/error.tsx.

NoteAll three parts confirmed against the file. Medium is right: this is the destination of every plan denial in the product, so it is where the upsell is actually lost.

medium
A session with no active organisation is a dead end, and the NO_ACTIVE_ORG branch is unreachable
Web app
apps/web/src/app/(dashboard)/layout.tsx:24
WhenVerified: identify (packages/auth/src/identity.ts:28-29) returns null both for 'no session' and 'session with activeOrganizationId null'. A user in that state is let through proxy.ts (cookie present), redirected to /sign-in by layout.tsx:24, signs in successfully, and auth.ts:116 sets activeOrganizationId to null again — back to /sign-in. /onboarding is outside the (dashboard) group so it renders, but its only action calls organization.create through the gateway, where dispatch step 1 (gateway.ts:124-125) fails UNAUTHORIZED because identify returned null. There is no reachable recovery path in the product.

FixChange identify in packages/auth/src/identity.ts to return a discriminated result (null for no session, { userId, orgId: null } for a session with no membership); make apps/web/src/app/(dashboard)/layout.tsx send the orgId:null case to /onboarding; and in packages/guardrail/src/gateway.ts allow the org-less identity through step 1 so the existing NO_ACTIVE_ORG check at line 129 becomes live — plus permit organization.create specifically for an org-less caller (it is the only operation that can create the missing org), otherwise /onboarding still cannot rescue the user.

NoteConfirmed as a defect, but the auditor's trigger is REFUTED and the auditor's fix is incomplete. (a) 'a user in exactly one org can leave it' is wrong: services/identity/src/index.ts:189 calls assertNotTheLastOwner, and packages/auth/src/auth.ts user.create.after gives every user an org they own, so a solo user cannot leave. The reachable triggers are narrower — a co-owner removing them via member.delete, or organization.delete. (b) '/onboarding already goes through the gated organization.create route, so it is the correct landing page' is wrong: that call returns UNAUTHORIZED for an org-less caller (identify → null), and organization.create is additionally minRole owner and consumes with limits.free = false (registry.ts:110). Severity lowered from high to medium on reachability.

medium
Dashboard page renders run identify + entitlements with no rate limit at all
Web app
apps/web/src/app/(dashboard)/layout.tsx:26
WhenConfirmed: layout.tsx:23 calls identify() and :26 calls gatewayDeps.entitlements() directly, not through dispatch, so gate 5 (packages/guardrail/src/gateway.ts:166) never runs on this path. A signed-in member looping GET /projects costs a getSession plus a member SELECT (packages/auth/src/identity.ts:25-36) per request, with no limit and no counter. The auditor's 'a NATS rpc to billing per request' overstates it: deps.ts:22-23 caches entitlements per org for 30s, so the rpc fires at most twice a minute per org, not per request.

FixIn apps/web/src/app/(dashboard)/layout.tsx, after identify() at line 23, call rateLimit({ key: page:${identity.userId}, max, windowSeconds }) from apps/web/src/gateway/ratelimit.ts and redirect to a 429 page when refused. Alternatively add a coarse per-session limit in apps/web/src/proxy.ts covering every non-static route, which also covers the forged-cookie path.

NoteSeverity reduced from high to medium: the gap is real (no limiter on the route-guard path) but the per-request cost is two DB queries, not a NATS round trip - the 30s entitlements cache absorbs that.

medium
A rate-limited server-rendered page becomes a 500 with no error boundary
Web app
apps/web/src/app/(dashboard)/projects/page.tsx:6
WhenConfirmed. projects/page.tsx:6 calls api.project.list(...) through createCaller (apps/web/src/trpc/server.ts), which runs the full gateway block in-process, so an RSC render spends the same per-org budget as browser traffic and can itself throw RATE_LIMITED at gateway.ts:171. find apps/web/src -name 'error*.tsx' returns nothing - there is no error.tsx and no global-error.tsx anywhere in the app - so the user gets Next's generic error page rather than a 'try again in N seconds' screen, and the same is true for UPGRADE_REQUIRED and SERVICE_UNAVAILABLE during SSR, which are far more likely (billing degradation returns EMPTY_ENTITLEMENTS and can flip a paying org to a free-plan refusal mid-render).

FixAdd apps/web/src/app/(dashboard)/error.tsx as a client error boundary that reads the TRPCError cause (error.data.app, populated at apps/web/src/gateway/init.ts:56) and renders RATE_LIMITED with retryAfterSeconds, UPGRADE_REQUIRED with the upgrade prompt, and SERVICE_UNAVAILABLE with a retry. Consider a distinct limiter key for the RSC caller so a page render and the client's rehydration refetch do not charge the same budget twice.

NoteVerified there is no error boundary file anywhere under apps/web/src. Medium retained - it is UX/operational rather than a security or data defect, but it turns every limit hit into what looks like a crash.

medium
Invitation acceptance is deliberately outside the block: no seat gate, no audit row, no envelope
HTTP edge
apps/web/src/app/api/auth/superseded.ts:72
WhenConfirmed and documented. superseded.ts:72-75 keeps organization/accept-invitation and organization/reject-invitation mounted on Better Auth. Better Auth writes the member row itself from invitation.role, so a join produces no envelope, no plan gate and no evt.* — and since the audit trail is built purely from evt.> (services/audit/src/index.ts:49-63), audit_log has no row for the most security-relevant event in the product. Concretely: an org on Scale invites ten admins, downgrades to free (member limit 2), the ten pending invitations are then accepted, and the org sits at eleven seats with no gate consulted and eleven unrecorded joins. Compounds finding #3 above: seats are metered when the invitation is sent and never when it is accepted, so the number the plan gate reads has no relationship to the number of people in the tenant.

FixAs proposed: declare an invitation.update (accept) operation in packages/registry/src/registry.ts owned by identity, minRole member, consumes true against the member featureId; add its contract (invitation id only) to packages/contracts/src/resources/identity.contract.ts; add the handler in services/identity/src/index.ts that looks the invitation up by id, checks the email against the caller's, inserts the member row and deletes the invitation; move both paths from KEPT to SUPERSEDED in apps/web/src/app/api/auth/superseded.ts. The "actor is not yet a member" objection in the KEPT note is answered by gating on the unguessable invitation id rather than ctx.orgId, but note that the envelope still needs an orgId — the accepting user's *current* org is the honest value, with the target org read from the invitation row.

NoteConfirmed, and the KEPT entry documents it. Kept at medium. I sharpened one thing the original glossed: an envelope needs some orgId, so the design has to say which one — otherwise this reopens the exact ctx.orgId question the block exists to settle.

medium
onError logs only the message: no requestId, no stack, and it fires for ordinary denials
HTTP edge
apps/web/src/app/api/trpc/[trpc]/route.ts:18 · reported by 2 auditors (gateway-http-web, ops-observability-config)
AlsoNo structured logging, no correlation id on request-path logs, no metrics

WhenAll 61 log statements in the repo are bare console.* strings. The gateway's only request-path log is console.error("[gateway] ${path}: ${message}") here: no requestId (which proxy.ts:24 mints and which keys the audit trail), no orgId, no userId, no duration, and no line at all for a successful request. packages/guardrail/src/gateway.ts logs nothing across all ten gates, so a customer report of 'it says I need to upgrade' leaves no server-side record of which gate refused. There are no counters or histograms anywhere, so 'the projects service is timing out' is undetectable until a customer emails - the SERVICE_UNAVAILABLE path at gateway.ts:233 does not even log the transport error it swallows.

FixAdd a minimal JSON logger (new packages/observability, or an export from packages/env) emitting {requestId, orgId, userId, resource, operation, durationMs, outcome, code}; call it once per dispatch in packages/guardrail/src/gateway.ts (including in the fail path and the catch at 227-237) and once per delivery in packages/guardrail/src/service.ts, and expose the same counters via the health endpoint from finding 2.

NoteVerified: 61 console.* call sites, zero in gateway.ts, and the catch at gateway.ts:227 discards the transport error without logging it.

medium
Tailwind is never told to scan packages/ui, so the shared library's classes may not be generated
Web app
apps/web/src/app/globals.css:1
WhenVerified statically: globals.css:1 is a bare @import "tailwindcss" with no @source; there is no tailwind.config.* in the repo; apps/web/postcss.config.mjs passes {"@tailwindcss/postcss": {}} with no base. @guardrail/ui reaches the app through apps/web/node_modules/@guardrail/ui (a workspace symlink) and v4 auto-detection skips node_modules. If detection roots at apps/web (the plugin's base defaults to the build cwd, and Next builds run with cwd = apps/web), classes that exist only in packages/ui/src — bg-primary, text-primary-foreground, hover:bg-primary/90 from buttonVariants, plus the Card/Input/Table strings — are never emitted and the primary button renders as unstyled text.

FixAdd @source "../../../../packages/ui/src"; immediately after line 1 of apps/web/src/app/globals.css (that path resolves to the repo root, then packages/ui/src). It makes the contract explicit regardless of detection root and is required if the app is ever built with Root Directory = apps/web on Vercel.

NoteKept PLAUSIBLE, as the original author flagged: confirming it needs a build, which is forbidden here. Everything statically checkable is confirmed — no config, no @source, symlinked dependency, and classes that genuinely exist only in packages/ui.

medium
Dark mode omits --ring, --destructive and --destructive-foreground, leaving low-contrast error text
Web app
apps/web/src/app/globals.css:48
WhenVerified: the @media (prefers-color-scheme: dark) block at globals.css:48-65 overrides fourteen tokens and omits --ring, --destructive and --destructive-foreground, which stay at the :root values. In dark mode --card is oklch(21%) while --destructive stays oklch(56% 0.19 25), giving roughly 3.4:1 for the 14px error text at project-list.tsx:72, member-list.tsx:109-110, sign-in/page.tsx:30 and onboarding/page.tsx:45 — below the 4.5:1 minimum. --ring stays oklch(45%) against an oklch(17%) background, which is the genuinely weak focus ring (this is the case the previous finding should have made).

FixAdd --ring, --destructive and --destructive-foreground overrides to the dark block in apps/web/src/app/globals.css:48-64 (ring and destructive around 70% L, destructive-foreground dark) so all three invert with the rest of the palette. Do not add @custom-variant.

NoteThe omission and the contrast maths hold. The second half of the finding is REFUTED: Tailwind v4's built-in dark: variant IS @media (prefers-color-scheme: dark) by default — the .dark class mechanism is what shadcn opts into via @custom-variant. This file matches the framework default, so adding @custom-variant would change behaviour rather than fix a mismatch.

medium
The onboarding page has no client mirror at all, on the one resource whose free-plan limit is false
Web app
apps/web/src/app/onboarding/page.tsx:47
Whenorganization limits are {free: false, pro: 3, scale: "unlimited"} (packages/registry/src/registry.ts:110) and organization.create consumes, so the gateway refuses it for every free-plan org at gateway.ts:180-186. onboarding/page.tsx renders the Input and the 'Create organisation' button with no Gate, no FeatureGate and no useAccess — a free-plan user types a name, clicks, and gets the registry's upsell copy painted as raw red error text at line 45. It is the only mutation surface in the app with no gate on it, and it is the case the mirror exists to prevent.

FixWrap the form in apps/web/src/app/onboarding/page.tsx:43-52 in <Gate resource="organization" operation="create"> (after fixing gate.tsx's fallback default so the UpgradePrompt renders). The page sits outside the (dashboard) segment and therefore outside ViewerProvider, so also mount a provider for it — move the segment under (dashboard), or fetch entitlements in a server wrapper the way layout.tsx:26-38 does; otherwise the gate silently reads the fabricated default context.

medium
Sidebar discards navAccess.locked, so a locked item looks normal and bounces the user to a Billing page that says nothing
Web app
apps/web/src/components/sidebar.tsx:10
WhenVerified: derive.ts computes NavAccess {visible, locked} (~lines 412-432) with the comment that a locked item is an upgrade prompt, but visibleNav filters on visible and returns bare NavItems; sidebar.tsx:12-18 renders every item as the same enabled Link. A free-plan admin sees "Audit log" styled exactly like Projects; clicking it hits layout.tsx:34 which redirects to /billing?locked=auditLog, and billing/page.tsx (37 lines, no searchParams parameter) shows a generic page. The locked state the registry computes reaches no pixel.

FixChange visibleNav in packages/registry/src/derive.ts to return readonly (NavItem & NavAccess)[] (it already computes navAccess per item), and in apps/web/src/components/sidebar.tsx render a locked entry with aria-disabled, muted classes and a lucide Lock icon pointing at the billing href. Pair with the billing-page searchParams fix so the redirect lands on an explanation.

NoteConfirmed exactly as described, including the derive.ts comment. Medium is right — upsell/UX loss, not a security gap; the layout still enforces the redirect.

medium
There is no sign-out control anywhere in the product, and sessions renew indefinitely
Web app
apps/web/src/components/sidebar.tsx:6
WhensignOut is exported at packages/auth/src/client.ts:30 and grep across apps/web finds no importer. Sidebar renders nav links and a plan badge only (sidebar.tsx:6-26); there is no account menu anywhere in the tree. session.expiresIn is 7 days with updateAge 1 day and no absolute cap (auth.ts:60-64), so a session on a shared or stolen machine cannot be ended by the user and renews forever as long as it is used weekly. No session list / 'sign out other devices' surface exists either, though Better Auth mounts those endpoints.

FixAdd a small client component rendered from apps/web/src/components/sidebar.tsx calling authClient.signOut() then router.push('/sign-in'), and consider an absolute lifetime via session.disableSessionRefresh plus a maximum-age check in packages/auth/src/identity.ts.

NoteConfirmed by grep: signOut has exactly one occurrence in the repo, its export. This and the revocation finding are one UI change plus one config change.

medium
Query errors are never rendered — a failed refetch leaves stale rows with no indication
Web app
apps/web/src/features/projects/project-list.tsx:28
WhenVerified: project-list.tsx renders create.error (line 72) but never projects.error or projects.isFetching; member-list.tsx renders invite/remove errors (109-110) but never members.error. Both queries carry initialData, so TanStack retains the last good data on a failed refetch. After a create, invalidateQueries triggers a refetch; if the projects service is down that refetch fails silently and the user keeps looking at a list that no longer matches the server — no banner, no redirect on UNAUTHORIZED.

FixRender the shared <Denial error={projects.error}/> above the Card whenever projects.isError in apps/web/src/features/projects/project-list.tsx, and the same for members.error in features/team/member-list.tsx; add aria-busy={projects.isFetching} to the Card wrapper. For UNAUTHORIZED have Denial call router.refresh() so the layout's identify() check redirects to /sign-in.

NoteConfirmed; one premise weakened — query-client.ts:13 sets refetchOnWindowFocus: false, so the 'idle tab, session expires' path needs an explicit interaction. The post-mutation invalidation refetch is the realistic trigger and is unaffected.

medium
Viewer entitlements are never refreshed after a consuming mutation, so the mirror keeps offering a refused control
Web app
apps/web/src/features/projects/project-list.tsx:37
WhenVerified: ViewerProvider is populated once per server navigation (layout.tsx:26,38); onSuccess in project-list.tsx:37-41 and member-list.tsx:46-52 only invalidates the tRPC list query; a repo-wide grep for router.refresh|revalidatePath|revalidateTag returns zero hits. A free admin at 1/2 creates a project: the list shows 2 rows but useResourceDecision still reads usage.project = 1, the Create button stays live, and the next click returns UPGRADE_REQUIRED rendered as raw red text. /team's "Seats 1 of 2" is stale the same way.

FixIn the onSuccess of apps/web/src/features/projects/project-list.tsx:37 and apps/web/src/features/team/member-list.tsx:46 call router.refresh() from next/navigation alongside the invalidation, for operations whose registry rule has consumes: true. That alone is not enough: apps/web/src/gateway/deps.ts caches entitlements for 30s, so also wire invalidateEntitlements(orgId) — currently dead code, see the separate finding — to the evt.* consumers for consuming operations.

NoteSeverity lowered to medium: the gateway is the authority and refuses correctly, so the outcome is a bad denial experience, not a breach. One premise corrected — the auditor wrote that invalidateEntitlements 'only clears on evt.billing.manage'; grep shows it is exported at deps.ts:25 and called from nowhere at all, so router.refresh() alone would still read a stale 30s cache.

medium
Error and success messages are not announced; pending buttons have no aria-busy
Web app
apps/web/src/features/team/member-list.tsx:109
WhenVerified: member-list.tsx:109-110 and :113-115 insert error and success paragraphs into the DOM with no role or aria-live; project-list.tsx:72, onboarding/page.tsx:45 and sign-in/page.tsx:30 are identical. A screen-reader user clicks Invite, the request is refused, and nothing is announced. The success line matters more than usual because member.invite is a command — no row appears, so that sentence is the only feedback. Buttons swap their label to "Inviting…"/"Creating…" (member-list.tsx:102, project-list.tsx:66) with no aria-busy, announced as a name change rather than a busy state. A repo-wide grep finds exactly one aria- attribute in the whole app (member-list.tsx:87).

FixPut role="alert" on the denial paragraphs and role="status" on the success paragraph — best done once inside the shared packages/ui/src/components/denial.tsx — and add aria-busy alongside the existing disabled at member-list.tsx:98-99 and project-list.tsx:62-63.

NoteConfirmed; the single-aria-attribute grep result shows this is systemic rather than a one-off omission.

medium
Every Remove button has the same accessible name, fires with no confirmation, and disables the whole list
Web app
apps/web/src/features/team/member-list.tsx:129
WhenVerified: inside the row map at member-list.tsx:129-136 each button reads only "Remove", with the member name in a sibling div (line 123) and no programmatic association — a screen-reader user hears "Remove, Remove, Remove". onClick calls remove.mutate({memberId}) immediately (line 133): one stray Enter permanently removes a colleague's seat with no confirmation and no undo path in the UI. Line 132 reads the shared mutation's isPending, so removing one member greys out every row's button.

Fixapps/web/src/features/team/member-list.tsx: add aria-label={Remove ${member.name}} to the button; add a confirmation via pnpm ui:add alert-dialog with the member's name in the description; track the in-flight member id in useState so disabled applies only to that row.

NoteAll three sub-claims confirmed at the cited lines. Medium is right — destructive and irreversible from the UI, but permission-gated to member:delete holders.

medium
invalidateEntitlements has no caller and the gateway cannot subscribe to evt.* — the documented cache invalidation does not exist
Gateway
apps/web/src/gateway/deps.ts:25 · reported by 3 auditors (multitenancy-authz, ui-client-mirror, plan-gating-billing)
AlsoinvalidateEntitlements is exported from deps.ts and called from nowhere, so a plan upgrade is invisible for 30s  ·  invalidateEntitlements is dead code and the documented evt.billing.manage invalidation does not exist

Whendeps.ts:6-8 states "Entitlements are cached for 30s and invalidated by evt.billing.manage". The exported invalidateEntitlements at :25 has zero callers in the repo (verified by grep across apps, packages and services), there is no evt.* consumer anywhere in apps/web, and the gateway's NATS user has no subscribe permission for evt.> or the EVT stream at all (infra/nats/auth.conf:23-29 allows subscribe only on _INBOX.gateway.>). Concretely: an owner completes checkout and upgrades from free to pro; for up to 30s afterwards every request still reads the cached free entitlements, so their first project past the free limit is refused with UPGRADE_REQUIRED on a plan they have just paid for. On more than one Next.js replica it is worse — the Map at :23 is per-process, so even a working invalidation would only clear one replica's copy.

FixEither delete the misleading claim and the dead export, or finish it: add an evt.billing.manage consumer built with defineConsumer in a small apps/web/src/gateway/entitlements-consumer.ts calling invalidateEntitlements(meta.orgId), grant the gateway user subscribe on the EVT stream by re-running infra/nats/generate-auth.ts, and, for multi-replica correctness, move the cache behind the same Upstash store apps/web/src/gateway/ratelimit.ts already uses rather than a per-process Map.

medium
Entitlements from billing are cached with no schema parse (z.custom<TReply>() validates nothing)
Gateway
apps/web/src/gateway/deps.ts:40
WhenVerified: packages/transport/src/request.ts:98 returns z.custom<TReply>().parse(reply.data) - a no-validator z.custom accepts anything, so the generic is a cast; deps.ts:34-42 calls rpcRequest directly and caches reply.data.entitlements for 30s with no parse. Correction to the trigger: an in-version billing service cannot produce a bad plan, because handlerFor (packages/guardrail/src/service.ts:86) runs contract.output.parse and billing.contract.ts:14 pins plan to z.enum(PLAN_KEYS). The reachable condition is version skew - a rolling deploy where the billing service runs a registry with a plan the gateway does not know. Correction to the consequence, which is worse than stated: requestMeta.plan is z.custom<PlanKey>(isPlanKey) (packages/contracts/src/envelope.ts, requestMeta), so the poisoned plan goes into every envelope the gateway signs for that org and every service rejects it as 'Malformed envelope' -> UNTRUSTED_ENVELOPE on every operation, not just consumes ones, for the 30s cache life, refreshed on each miss.

Fixapps/web/src/gateway/deps.ts: parse before caching - const parsed = contractFor("billing","read").output.safeParse(reply.data), cache parsed.data.entitlements, and log + return EMPTY_ENTITLEMENTS on failure (the file already has that degrade path at lines 50-55). Better, change rpcRequest in packages/transport/src/request.ts:31 to take schema: z.ZodType<TReply> and parse with it instead of z.custom, killing the fake generic at every call site.

NoteCode claim confirmed (no parse, z.custom is a no-op). Downgraded high -> medium: the only reachable trigger is a mixed-version deploy, since the billing service's own contract.output.parse blocks a bad plan in a single-version deployment. Consequence sharpened - org-wide envelope rejection, not UPGRADE_REQUIRED.

medium
errorFormatter forwards any object with a code property to the browser, and internal messages reach the UI
Gateway
apps/web/src/gateway/init.ts:52
WhenConfirmed: the predicate at init.ts:53 is typeof error.cause === 'object' && 'code' in error.cause, not a GatewayFailure check, and tRPC wraps an unexpected throw as TRPCError{code:'INTERNAL_SERVER_ERROR', cause: original}. A postgres/drizzle error (code, detail, constraint, table) or an undici failure (cause.code = 'ECONNREFUSED') is therefore serialised into data.app. Separately the formatter spreads ...shape, keeping tRPC's default message: error.message even for INTERNAL_SERVER_ERROR, and apps/web/src/features/projects/project-list.tsx:72 renders create.error.message directly into the page — so a raw constraint name or an internal host:port is printed to an end user.

FixIn apps/web/src/gateway/init.ts narrow the app field with the existing isErrorCode helper from packages/contracts/src/errors.ts:45 (error.cause && typeof error.cause === 'object' && 'code' in error.cause && isErrorCode(error.cause.code)), and in the same formatter override message with a fixed string when shape.data.code === 'INTERNAL_SERVER_ERROR', logging the real message and stack from the onError hook in apps/web/src/app/api/trpc/[trpc]/route.ts instead.

NoteConfirmed. isErrorCode already exists in packages/contracts and is exported, so the fix is a one-line predicate change — no new type needed. The stack sub-claim is tRPC-default behaviour (dev only) and is the weakest part; the message-passthrough plus project-list.tsx:72 is the concrete leak.

medium
Fixed window allows 2x the declared max across a boundary
Gateway
apps/web/src/gateway/ratelimit.ts:57
WhenConfirmed: ratelimit.ts:57 computes Math.floor(now / (windowSeconds * 1000)) and embeds it in the key, a hard-edged fixed window; InMemoryStore (line 33-42) behaves the same way with a rolling resetAt. A caller sending 60 project.create in the last 200ms of one window and 60 more in the first 200ms of the next executes 120 in 400ms while never exceeding max 60/60s. Everything sized on that max - service concurrency, the 10-connection pool, and the plan-limit reasoning - sees twice what the registry declares.

FixIn apps/web/src/gateway/ratelimit.ts make UpstashStore.incr a sliding window: in one pipeline read the previous window's counter alongside INCR of the current one and weight the previous by the elapsed fraction, or replace both commands with a single EVAL implementing a token bucket. Update InMemoryStore so dev and prod agree.

NoteLine 57 exact. Medium is right - this is a known property of fixed windows, but it matters here because the plan-limit gate has no service-side backstop.

medium
Unauthenticated /api/trpc calls are redirected to the HTML sign-in page instead of returning UNAUTHORIZED
HTTP edge
apps/web/src/proxy.ts:33 · reported by 2 auditors (gateway-http-web, auth-session-identity)
AlsoAn expired session turns every API call into an HTML redirect instead of UNAUTHORIZED

WhenisPublic (proxy.ts:26-29) covers '/', /sign-in and /api/auth but not /api/trpc, and the matcher (proxy.ts:43) covers everything else. When the 7-day cookie expires while a tab is open, the next tRPC POST from httpBatchLink (apps/web/src/trpc/react.tsx:30) is answered with a 307 to /sign-in; fetch follows it and the client gets an HTML document, so every button fails with a JSON parse error instead of the UNAUTHORIZED that gateway.ts:125 exists to produce and that the UI could act on. Non-browser API clients see the same.

Fixapps/web/src/proxy.ts:26 — return NextResponse.next() for pathnames starting with /api/trpc (or add it to isPublic) and let dispatch()'s step 1 answer UNAUTHORIZED; then handle that code in apps/web/src/trpc/react.tsx by redirecting to /sign-in.

NoteConfirmed against both files. The proxy's own header says authorisation does not happen there, which makes the /api/trpc omission an inconsistency as well as a UX bug.

medium
TanStack Query retries every failure three times, amplifying an incident 4x
Web app
apps/web/src/trpc/query-client.ts:13
WhenConfirmed: query-client.ts:13 sets only staleTime and refetchOnWindowFocus, so TanStack Query's default retry: 3 applies to every query. A RATE_LIMITED or SERVICE_UNAVAILABLE response is retried three more times per query per tab, and each retry increments the org's Upstash counter again at gateway.ts:166 - so being rate-limited makes the org more rate-limited, and a billing/service degradation is multiplied fourfold exactly when the platform can least absorb it. Retries also ignore the retryAfterSeconds the server computed.

FixIn apps/web/src/trpc/query-client.ts:13 add retry: (count, error) => count < 2 && !['TOO_MANY_REQUESTS','FORBIDDEN','UNAUTHORIZED','BAD_REQUEST'].includes((error as TRPCClientError).data?.code) and a retryDelay that honours error.data.app.retryAfterSeconds for the RATE_LIMITED case (that field is populated by the errorFormatter at apps/web/src/gateway/init.ts:56).

NoteLine 13 exact; default retry:3 is TanStack Query behaviour and nothing overrides it. Medium is right.

medium
Local stack has no restart policy, JetStream is single-replica by config, and there is no backup/restore procedure
Infra
infra/docker-compose.yml:9
WhenNone of the four compose services declares restart:, so a docker daemon restart leaves the local stack down until make up. More importantly for production: the stream config built in packages/transport/src/streams.ts:20-27 sets name/subjects/description/max_age/duplicate_window and nothing else, so both STREAMS entries (derive.ts:328) are created with num_replicas 1 on any cluster - the CMD stream holding accepted-but-unexecuted invitations (7 days) and the EVT stream feeding the audit trail and metering (30 days) have no redundancy, and losing one node's store loses both. No backup, restore or PITR procedure exists anywhere: infra/nats/RUNBOOK.md covers keys and permissions only, README.md has no operations section, make help has no backup target.

FixAdd an env-driven num_replicas to the config object in packages/transport/src/streams.ts (1 locally, 3 clustered), add restart: unless-stopped to each service in infra/docker-compose.yml, and write infra/RUNBOOK-operations.md covering pg_dump/restore, nats stream backup/restore, and the migrate -> bootstrap -> roll ordering.

NoteVerified. Narrowing: the missing restart: is a local-dev annoyance only (the compose file starts no app process); the load-bearing part is the missing num_replicas in streams.ts and the absent backup runbook.

medium
Open sign-up mints a tenant per request with no audit row and no verification
Auth
packages/auth/src/auth.ts:53 · reported by 4 auditors (auth-session-identity)
AlsoNo email verification: identities in the member roster and the audit trail are attacker-chosen  ·  No account lockout, no password policy, no MFA  ·  No password reset and no password change: a forgotten password loses the account permanently

WhenemailAndPassword is enabled with no disableSignUp (auth.ts:53; better-auth/dist/api/routes/sign-up.mjs:145 only refuses when disabled or disableSignUp), /sign-up/email is not in SUPERSEDED, and databaseHooks.user.create.after (auth.ts:85) inserts an organization + member row for every user created. Unauthenticated requests therefore write three rows each, with no plan gate, no evt.organization.create and so no audit row and no metering — the tenant that every later audit row is scoped to has no creation record, which contradicts the auditLog resource's own description 'Immutable record of every mutation' (registry.ts:302). The only brake is Better Auth's default 3-per-10s rule, which is in-memory per replica and keyed on an IP that may not resolve at all (see the rate-limit finding).

Fixpackages/auth/src/auth.ts:53 — emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12 } plus an emailVerification.sendVerificationEmail, and rateLimit: { enabled: true, storage: "secondary-storage", customRules: { "/sign-up/email": { window: 3600, max: 5 } } } on the shared Upstash backend. For the audit hole, publish evt.organization.create from the signup hook (or from a small helper the hook calls) using the same signed-envelope helper as apps/web/src/gateway/internal-envelope.ts, so services/audit records the tenant's birth. If the product is invite-only, set emailAndPassword.disableSignUp: true and create accounts from the invitation-accept path.

NoteMechanism confirmed, severity corrected critical -> medium. Self-serve signup is a product choice, not a defect, and the 'loop it to mint tenants' amplification is bounded by the vendor's 3/10s rule (and, in the unresolvable-IP shape, by a single global bucket). The durable defects are the missing audit/metering event for the auto-created org and the unverified address.

medium
Session revocation is honoured only after the cookie cache and cannot be forced at all
Auth
packages/auth/src/auth.ts:63
WhencookieCache is enabled with maxAge 30 (auth.ts:63) — documented in the file as the window in which a revoked session is still honoured. What is not documented: there is no central revocation at all. No secondaryStorage is configured, so sessions exist only as rows in the auth database; nothing in the repo calls revokeSession/revokeSessions/revokeOtherSessions, revokeSessionsOnPasswordReset is off, and there is no admin surface. Deployment condition: a stolen laptop or a terminated employee — today the answer is a manual DELETE against the session table, and the cookie cache still honours the session for up to 30 more seconds. Membership and role changes are safe (identity.ts:31-40 re-reads the member row every request), so the exposure is session-level only.

Fixpackages/auth/src/auth.ts — add secondaryStorage against the shared Upstash client (the module extracted from apps/web/src/gateway/ratelimit.ts) so session lookups and revocations are central, set emailAndPassword.revokeSessionsOnPasswordReset: true, and expose 'sign out everywhere' from the account menu added with the sign-out control.

NoteConfirmed; the 30s window is documented but the absence of any revocation path is not. Note the same secondaryStorage edit also fixes the rate-limit storage finding — one change, two findings.

medium
Deleting an organisation or removing a member leaves session.activeOrganizationId dangling, locking the user out
Auth
packages/auth/src/identity.ts:28
WhenConfirmed. packages/auth/src/schema.ts:30 is activeOrganizationId: text('active_organization_id') — plain text, nullable, no FK, no cascade. identity.ts:28-39 reads it, looks up the member row, and returns null when the row is missing; packages/guardrail/src/gateway.ts:124-125 turns that null into UNAUTHORIZED. Nothing clears the column: organization.delete goes through identityService.deleteOrganization (which touches only invitation/member/organization) and member removal goes through identityService.removeMember — neither touches session, and the Better Auth hooks in auth.ts only set activeOrganizationId on session *create* (line 100-112). A user in orgs A and B with A active who is removed from A, or whose A is deleted, gets UNAUTHORIZED on every request despite a valid 7-day session and a good membership in B, and appears signed out until they manually sign out and in — the redirect-loop class the auth.ts:100-112 hook was written to eliminate.

FixIn packages/auth/src/identity.ts, when the member lookup at 31-35 misses, re-run the auth.ts session-create query (authDb.query.member.findFirst({ where: eq(userId), orderBy: [asc(createdAt), asc(id)] })), persist the result back onto the session row, and return null only when the user has no membership at all.

NoteVerified that no code path clears the column and that identify's null becomes UNAUTHORIZED. Medium is right: recoverable by re-authenticating, but the user has no way to know that.

medium
Removal from an organisation signs the user out of every organisation, and the gateway's NO_ACTIVE_ORG gate is dead code
Auth
packages/auth/src/identity.ts:38
Whenmember.delete runs in the identity service (services/identity/src/index.ts:76) and deletes the row; nothing can touch the session's activeOrganizationId, which only the gateway holds. On the removed user's next request identify() finds no member row and returns null (identity.ts:38) — indistinguishable from 'not signed in' — so gateway.ts:125 answers UNAUTHORIZED 'Sign in to continue' and layout.tsx:24 bounces them to /sign-in even though they still belong to other organisations. They recover only by re-entering their password, after which the session.create hook (auth.ts:111-116) picks their earliest remaining membership. The same conflation makes gateway.ts:129's NO_ACTIVE_ORG branch unreachable: identify() never returns an identity with an empty orgId, so that declared gate and its error code never fire.

FixSame edit as the lockout finding: make packages/auth/src/identity.ts return a discriminated result ({ kind: 'anonymous' } | { kind: 'no-org', userId } | GatewayIdentity), fall back to the earliest remaining membership when the active org is stale, and map the no-org case onto the existing NO_ACTIVE_ORG failure in packages/guardrail/src/gateway.ts:129 so the UI can show an org switcher instead of a login form.

NoteConfirmed, severity kept at medium rather than high: unlike the zero-membership case this is recoverable by signing in again. Same root cause and same fix as the lockout finding — treat them as one change.

medium
Organisations are never registered as Autumn customers — ensureCustomer has no caller
Billing
packages/billing/src/autumn.adapter.ts:130 · reported by 2 auditors (plan-gating-billing, auth-session-identity)
Alsobilling.ensureCustomer is dead code: no organisation ever gets a billing customer provisioned

Whengrep across apps/, packages/ and services/ finds exactly one occurrence of ensureCustomer — its definition. Neither the signup hook (packages/auth/src/auth.ts:85, which creates the first workspace) nor the organization.create handler (services/identity/src/index.ts:141) provisions the Autumn customer keyed on organizationId that every other billing call assumes: getEntitlements does customers.get(organizationId) (autumn.adapter.ts:66) and swallows the resulting not-found in the catch at line 69, silently returning the free-plan FALLBACK, and checkout attaches to a customer_id that was never created with a name or email (autumn.adapter.ts:120-124). Concretely: a tenant created at signup has no billing identity, its entitlements are 'free' because the lookup errors rather than because the plan says so, and the first upgrade attaches to a bare or non-existent customer with no contact data — indistinguishable at the adapter from a genuine free plan.

FixAdd an evt.organization.create consumer in services/billing/src/index.ts (next to the existing evt.> meter at line 70, using defineConsumer so the envelope is verified) that calls billing.ensureCustomer with the org id, name and owner email. Then make the two creation paths publish that event: services/identity/src/index.ts:141 after createOrganization, and packages/auth/src/auth.ts:85 for the signup-created workspace (the same event the audit gap in the open-signup finding needs), so the billing identity of a tenant is provisioned exactly where the tenant is born.

medium
Only successes are ever audited — denied requests, forged-envelope refusals and dead-lettered commands leave no trace
Wire
packages/contracts/src/envelope.ts:109
WhenConfirmed. EVENT_OUTCOMES is ["success"] (envelope.ts:109) and eventPayload can express nothing else (:111). service.ts:280-286 emits only inside the try after a successful execute; every reject(...) path — UNTRUSTED_ENVELOPE at :233, wrong-subject at :248, PERMISSION_DENIED from step 5/5b at :198/:207, and the INTERNAL catch at :308 — returns without publishing. Gateway refusals (gateway.ts steps 3, 4, 4b, 6) never touch the bus at all. So: an admin repeatedly probing member.update to mint an owner is refused twice and audit_log records nothing; a stream of UNTRUSTED_ENVELOPE refusals — the single strongest signal that somebody is forging envelopes on the bus — reaches stdout only; and a command that dead-letters after five deliveries leaves an accepted:true in the browser and no row anywhere.

FixExtend EVENT_OUTCOMES in packages/contracts/src/envelope.ts to ["success","denied","failed"] (audit_log.outcome is already a plain text column, audit.service.ts:26). In packages/guardrail/src/service.ts emit from reassertAuthority's two refusal paths with outcome "denied" and from the catch at :303 with "failed" — meta is verified by then, so it is signable. For gateway-side refusals emit from packages/guardrail/src/gateway.ts before fail() for PERMISSION_DENIED/UPGRADE_REQUIRED using the system-envelope pattern in apps/web/src/gateway/internal-envelope.ts; note the gateway NATS user has no evt.* publish permission today (auth.conf:26), so infra/nats/generate-auth.ts needs regenerating.

NoteConfirmed. Added the missing infra step: as written the gateway physically cannot publish an evt.* subject, so the fix is incomplete without regenerating auth.conf.

medium
canonicalise throws on an explicitly-undefined property that zod preserves, and the throw is not caught on the signing side
Wire
packages/contracts/src/envelope.ts:163
WhenI ran zod 4.4.3 out of packages/contracts/node_modules: z.object({cursor: z.string().nullish(), limit: z.number()}).parse({cursor: undefined, limit: 2}) returns an object where "cursor" in result is true. superjson (apps/web/src/gateway/init.ts:44) transmits explicit undefined faithfully. So a caller passing {cursor: undefined, limit: 20, includeArchived: false} reaches gateway.ts:203, the parsed payload keeps the cursor key, and gateway.ts:208 signRequest -> contentHash -> canonicalise hits the default branch at line 163 and throws 'Cannot canonicalise a value of type undefined'. That throw is not a GatewayError, so procedures.ts:27 rethrows it and the caller gets a raw 500 with no code, deterministically, for that call shape. verifyAgainst (signing.ts:47-56) guards only the verify side; nothing guards the sign side. The same applies to description/name/archived in project.update and to organization.update.

Fixpackages/contracts/src/envelope.ts, object branch of canonicalise (lines 138-162): skip entries whose value is undefined rather than recursing into the throwing default. That is exactly what JSON.stringify does to the bytes that cross the bus, so signer and verifier still agree, and the ambiguity the comment at 168-177 worries about is gone because the wire form already dropped the key. Keep the throw for functions and symbols.

NoteBehaviour confirmed by executing zod 4.4.3 directly. One correction: no shipped call site triggers it - project-list.tsx:29 passes {limit: 20, includeArchived: false} and page.tsx:6 the same, member-list.tsx:42 passes {}, and every mutate() call omits its optional fields. So this is a deterministic landmine for the next optional-field call site, not a live 500 today; medium is right for that reason rather than the auditor's.

medium
Command envelopes never expire, so a captured command has no time bound
Wire
packages/contracts/src/envelope.ts:316
WhencheckFreshness applies the deadline only when transport === "rpc"; for a command the only clock checks are that issuedAt is not in the future (line 299) and that the budget is positive and under MAX_TIMEOUT_MS + skew (line 308). The documented reasoning is that the CMD stream's max age expires a command, but max age expires a message sitting in the stream, not a captured envelope republished later - that republish starts a fresh 7-day life. So a cmd.member.create envelope captured today is still accepted by identity in six months, and publishCommand's msgID dedup (request.ts:109) only covers the 2-minute duplicate_window in streams.ts:26. With no dedup store wired there is no bound of any kind on repetition.

Fixpackages/contracts/src/envelope.ts checkFreshness: keep the deadline exemption but add an absolute ceiling - for transport === "command", refuse when now - meta.issuedAt exceeds the CMD stream's max age, read from STREAMS in packages/registry/src/derive.ts:328-334 rather than hard-coded. That is the bound the comment at lines 284-292 claims already exists.

NoteConfirmed; severity high -> medium. Publishing to cmd.> requires the gateway nkey (auth.conf:26), and the only command in the registry today, member.create, is idempotent by email (services/identity/src/index.ts:60-64) - but only while the invitation row exists, so a replay after the invite is accepted or revoked does re-send. The finding's real weight is that nothing forces the next command handler to be idempotent.

medium
successUrl is fully caller-supplied — an open redirect out of the payment flow
Wire
packages/contracts/src/resources/billing.contract.ts:27
Whenpackages/contracts/src/resources/billing.contract.ts:27 declares successUrl: z.string().url(), which accepts any absolute URL including a foreign origin, and services/billing/src/index.ts:48 passes it straight to packages/billing/src/autumn.adapter.ts:123 as Autumn's success_url. An owner (billing.manage is owner-only) who follows a crafted in-app link, or a compromised/XSS'd client, starts a real checkout whose post-payment redirect lands on https://attacker.example/billing — a clone showing "payment failed, re-enter your card" immediately after a genuine Stripe charge. There is also no cancelUrl in the contract at all, so an abandoned checkout returns to Autumn's default rather than the app.

Fixpackages/contracts/src/resources/billing.contract.ts:27 — change to a path-only string, successUrl: z.string().startsWith("/"), and add cancelUrl on the same terms. services/billing/src/index.ts:44-50 — build the absolute URL there with new URL(input.successUrl, env.appUrl()) (env.appUrl already exists, packages/env/src/index.ts:69) and refuse anything whose resulting origin is not env.appUrl(). The adapter keeps taking an absolute string.

NoteConfirmed as written, but note the exploit needs an owner session driven to the mutation — billing.checkout currently has no caller in the UI. Medium is right; not critical.

medium
member.read and invitation.read return every row with no pagination
Wire
packages/contracts/src/resources/identity.contract.ts:23
WhenConfirmed. identity.contract.ts:23 declares read: { input: z.object({}), output: z.object({ items: z.array(memberDto) }) } - no limit, no cursor - and invitationContract.read at :51 is the same, unlike projectContract.read (limit max 100) and auditContract.read (limit max 200). services/identity/src/identity.service.ts:18-30 issues an unbounded SELECT with a join to user, and the handler at services/identity/src/index.ts:45 maps every row. infra/nats/nats.conf declares no max_payload, so the server default of 1MB applies: a large org's reply exceeds it, message.respond throws inside serve.ts:39, the catch at :41 sends the pre-signed unreadable refusal, and the Team page fails permanently for that org while the service re-runs the full query on every retry. The 50,000-member figure is extreme; the 1MB ceiling is reached far earlier, in the low thousands of members.

FixAdd cursor/limit to memberContract.read and invitationContract.read in packages/contracts/src/resources/identity.contract.ts (mirror projectContract.read: limit int min 1 max 100 default 20, nextCursor in the output), page the queries in services/identity/src/identity.service.ts:18 and :51, and update apps/web/src/app/(dashboard)/team/page.tsx. Also declare an explicit max_payload in infra/nats/nats.conf so the ceiling is stated rather than inherited.

NoteAll four files checked. Medium is right; corrected the failure mode (a signed refusal reaches the caller, not a hang) and the row count at which it bites.

medium
packages/contracts is declared client-safe but its barrel re-exports a node:crypto module
Wire
packages/contracts/src/signing.ts:14
Whenbiome.json:105-122 forbids importing "server-only" in packages/contracts because it must stay client-safe, and packages/contracts/src/index.ts:17 does export * from "./signing", which imports createHmac/timingSafeEqual from node:crypto. Today every apps/web component import of @guardrail/contracts is import type (project-list.tsx:9, member-list.tsx:14) and is erased, so nothing breaks. The moment a client component imports a *value* from the barrel - isErrorCode or ERROR_HTTP_MAP from errors.ts is the obvious one for rendering a denial - the star-export pulls signing.ts and node:crypto into the browser bundle. Biome's components override (lines 144-165) restricts @guardrail/guardrail, @guardrail/auth and @guardrail/billing but not @guardrail/contracts, and useImportType only forces import type when nothing but types is used, so nothing catches it; the failure surfaces as a Next build/polyfill error with no rule pointing at the cause.

FixEither split the barrel - move signing.ts out of packages/contracts/src/index.ts and expose it as a subpath export consumed only by @guardrail/guardrail and @guardrail/transport - or add "@guardrail/contracts" to the noRestrictedImports paths of the biome.json components/features override at line 156 with the message that client code reads wire types via import type only.

medium
Shared symmetric secret for gateway plus four services, with no key id to grow out of it
Wire
packages/contracts/src/signing.ts:24
WhenEvery process reads env.envelopeSecret() (services/*/src/index.ts, deps.ts:68, request.ts:70) and hmac() keys request, event and reply MACs on that one value. The file's stated goal - 'a compromised service should not be able to hand another service a forged org id, nor hand the gateway a forged answer' - is not achieved by this file: a compromised identity process holds the exact key needed to mint any envelope or reply for any resource and any orgId. What actually stops it is infra/nats/auth.conf's per-user publish lists (a compromised projects service may publish only evt.project.*), a different control in a generated file the signing layer knows nothing about. RequestMeta (envelope.ts:33-55) carries no key id, so per-service keys cannot be introduced later without a wire break.

FixAdd keyId: z.string() to requestMeta in packages/contracts/src/envelope.ts - it sits inside the satisfies Record<keyof RequestMeta | ...> at line 225, so it is signed automatically - and change signRequest/verifyRequest/signReply in packages/contracts/src/signing.ts to take a keyring Record<keyId, secret>. Step one ships one key id; step two issues a key per service in packages/env and lets defineService accept only key ids entitled to its own resources.

NoteCode confirmed; severity high -> medium. The auditor's own reasoning shows the isolation is carried by auth.conf, and I verified those publish lists are tight (auth.conf:35,46,57,67 - no service may publish to any rpc.* subject, and each may publish only its own evt.*), so the concrete 'compromised audit service deletes an org' scenario is blocked today. signing.ts:11 documents the single-secret choice as a deliberate 'swap when you outgrow it'. The durable defect is the missing keyId, which is what makes both this and the rotation finding un-fixable incrementally.

medium
refusedRole inspects only a top-level role key
The block
packages/guardrail/src/escalation.ts:24
WhenVerified: namedRole returns null unless the parsed body has a string at its own role key, and refusedRole is the whole implementation of gateway gate 4b (gateway.ts:156) and service gate 5b (service.ts:205). Confirmed that every current contract keeps role top-level (identity.contract.ts:36 and :44), so this is latent - but a bulk-invite contract shaped { members: [{ email, role }] } or a nested { update: { role } } passes both gates untouched, leaving only a handler remembering to call roleAtLeast. Nothing in tools/guardrail-check.ts notices a contract input carrying a role field the escalation gate cannot see.

FixMake namedRole in packages/guardrail/src/escalation.ts walk the body recursively and return every string found under a role/roles key, so nesting cannot hide a grant (both gates then inherit it). Back it with a rule in tools/guardrail-check.ts's contractInputs reporting a role property that is not a direct property of the top-level z.object.

NoteConfirmed as a latent auth gap; no current contract triggers it, which is why medium and not high. The recursive-namedRole fix is the better half of the two proposed - it fixes both gates in one file.

medium
gateway.ts's NO_ACTIVE_ORG branch is dead code, so an org-less user is told to sign in while signed in
The block
packages/guardrail/src/gateway.ts:129
Whenpackages/auth/src/identity.ts:28-29 returns null when session.activeOrganizationId is null, so dispatch's step 1 (gateway.ts:124-125) always fires first and the step-2 check if (identity.orgId.length === 0) at line 129 can never be reached — orgId is a non-empty string by then. Consequence: a signed-in user whose session has no active org receives UNAUTHORIZED 'Sign in to continue' rather than NO_ACTIVE_ORG 'Select an organisation to continue', so neither the client nor a future SDK consumer can distinguish 'you are logged out' from 'pick a workspace', and the whole NO_ACTIVE_ORG error code, its ERROR_HTTP_MAP row (packages/contracts/src/errors.ts:54) and its toFailure case (gateway.ts:288) are unreachable from the gateway.

FixChange identify in packages/auth/src/identity.ts to return { userId, orgId: '' , role } (or a discriminated shape) when the session exists but has no active organisation, so packages/guardrail/src/gateway.ts:129 becomes the live branch it was written to be. This is the same root cause as the sign-in loop finding and should be fixed in the same change.

medium
The gateway's command path has no error mapping, so a bus outage returns a raw 500 instead of SERVICE_UNAVAILABLE
The block
packages/guardrail/src/gateway.ts:213
Whenawait publishCommand({...}) at gateway.ts:213 sits outside any try/catch - the only one in dispatch() is at :221-233 and wraps rpcRequest alone. NATS is unreachable, the CMD stream does not exist because pnpm nats:bootstrap was never run against the environment, or the gateway nkey lost publish rights on cmd.member.create: js.publish rejects and the raw NatsError propagates out of dispatch. The rpc path for the same outage returns a clean SERVICE_UNAVAILABLE with a retry hint; the command path returns an unmapped transport error, leaking internals and giving the client no coded failure to branch on.

Fixpackages/guardrail/src/gateway.ts:212-218: wrap the publishCommand call in the same try/catch shape used at :221-233 - re-fail a ServiceError with its own code, and map anything else to fail({ code: 'SERVICE_UNAVAILABLE', message: \The ${definition.owner} service could not accept this request. Try again shortly.\ }). That also keeps the {accepted:true} contract honest: it must only be returned after a PubAck actually came back.

medium
An rpc handler keeps running and commits after the caller's deadline has expired
The block
packages/guardrail/src/service.ts:256
WhencheckFreshness is evaluated once on arrival (service.ts:256) and ctx.deadlineAt is handed to handlers (service.ts:270) but never read anywhere - grep for deadlineAt across packages/services/apps returns only the gateway assignment (gateway.ts:200) and these two lines. Under load rpc.project.create takes 6s against a 5000ms budget: rpcRequest times out, gateway.ts:229-233 tells the user 'The projects service did not respond', and one second later the handler commits the row, publishes evt.project.create, meters a unit and responds into an inbox nobody is listening on. The user retries and gets CONFLICT on the slug for a project they were told was never created.

Fixpackages/guardrail/src/service.ts:273-274: for binding.route.transport === 'rpc', race binding.entry.execute(ctx, payload) against a timer to meta.deadlineAt and return a DEADLINE_EXCEEDED reject when the timer wins, skipping the publishEvent at :280-286. Better, add signal: AbortSignal (built from deadlineAt) to ServiceContext at service.ts:46-53 so handlers can pass it to the database call rather than merely abandoning it.

NoteConfirmed by grep: ctx.deadlineAt has zero readers. Note the racing fix alone does not prevent the commit - it only stops the misleading event/meter and stops the handler holding a slot - which is why the AbortSignal half of the fix matters.

medium
Adding a plan to the registry silently gives it zero entitlements — limits is not keyed on PlanKey
Registry
packages/registry/src/define.ts:99
Whenpackages/registry/src/define.ts:99 declares readonly limits: Readonly<Record<string, Limit>> — any string keys — and RESOURCES in registry.ts:326 is only satisfies Record<string, ResourceDefinition>, so missing or misspelled plan keys are structurally legal. packages/registry/src/derive.ts:248 then does RESOURCES[resource].limits[plan] ?? false. Add enterprise: definePlan({...}) to PLANS, or typo prro: 25 in one resource, and pnpm typecheck passes clean — against a file whose own header (registry.ts:9) promises "the errors that appear are the work". Every enterprise customer gets not_in_plan on every resource: highest price, nothing included, "Not included" everywhere (usageLabel, derive.ts:288) and the sidebar locked.

Fixpackages/registry/src/registry.ts:326 — change the trailing satisfies Record<string, ResourceDefinition> to satisfies Record<string, ResourceDefinition & { limits: Record<PlanKey, Limit> }>. PlanKey is declared at registry.ts:47, above RESOURCES, so this needs no import and no change to define.ts (which cannot see PlanKey without a circular import). A plan added to PLANS without a limit in every resource then fails typecheck at the declaration site, which is the file the header says is the whole change.

NoteConfirmed. The fix is sharpened to the one-line satisfies in registry.ts rather than the more speculative helper type in derive.ts — verified PlanKey is in scope at that point in the file.

medium
StreamConfig cannot express replicas, storage or byte limits, so every deployment gets R1 unbounded streams
Registry
packages/registry/src/derive.ts:321
WhenStreamConfig carries only name/subjects/description/maxAgeDays (derive.ts:321-326) and streams.ts:20-27 sends nothing else, so both streams take the server defaults: num_replicas 1, file storage, no max_bytes, discard old - bounded only by max_file_store: 10GB in infra/nats/nats.conf:23, against a single nats service with no cluster in infra/docker-compose.yml:9. Two consequences: (a) that node's volume is lost and every accepted-but-unexecuted CMD message goes with it, after the gateway already returned {accepted:true}; (b) EVT reaches the account cap over 30 days of retention and js.publish starts failing, which per service.ts:280-286 turns every audited mutation into an INTERNAL error returned to the user after the write has already committed.

FixAdd maxBytes, replicas and storage to StreamConfig in packages/registry/src/derive.ts:321-326 with explicit values on both STREAMS entries, and pass them through in packages/transport/src/streams.ts:20-27. Document in infra/nats/RUNBOOK.md that the compose file is R1 development-only and that a deployment needs a 3-node cluster.

NoteThe code gap is CONFIRMED - there is literally no way to express replicas or max_bytes today, so a production bootstrap silently creates R1 streams. The deployment half is PLAUSIBLE: infra/docker-compose.yml self-documents as the local stack and there is no production manifest in the repo to check against.

medium
CMD has no retention policy declared, so acked commands linger for 7 days and any new durable re-executes them
Registry
packages/registry/src/derive.ts:330
WhenStreamConfig has no retention field and streams.ts:20-27 sends none, so both streams get the default Limits retention. A CMD message is kept for the full 7 days after identity has successfully executed and acked it. Combined with the missing deliver_policy, deleting a stuck durable to unblock an incident - or renaming a resource, which changes identity-${resource}-${operation} at identity/src/index.ts:213 - re-executes every command in the 7-day window from sequence 1. For cmd.member.create the check-then-skip at identity/src/index.ts:61-64 absorbs most of it, but each replay still re-emits evt.member.create outside the 2-minute duplicate window and re-meters the seat.

FixAdd retention to StreamConfig in packages/registry/src/derive.ts:321-326 and pass it through in packages/transport/src/streams.ts:20-27. Set CMD to WorkQueue so a message is removed the moment it is acked - viable here because identity creates one durable per command subject with non-overlapping filter_subjects, which is WorkQueue's only constraint - and leave EVT on Limits, since audit and billing both need to read every event. Note this must be applied by recreating CMD, not by streams.update.

medium
Metering is silently coupled to the audit flag — a resource declared consumes:true, audit:false is never metered and its cap becomes infinite
Registry
packages/registry/src/derive.ts:368
Whenpackages/registry/src/derive.ts:368 sets event: rule.audit ? eventSubject(resource, operation) : null, and packages/guardrail/src/service.ts:280 publishes only when binding.route.event !== null. The billing meter is an evt.> consumer (services/billing/src/index.ts:67-78), so metering exists only where audit does. Nothing — not the type in packages/registry/src/define.ts:66-79, not pnpm typecheck, not tools/guardrail-check.ts — refuses consumes: true, audit: false. The next person adding a resource that counts against the plan but is deliberately not audited (a high-volume API-call or storage feature is the obvious case) gets a plan limit that is silently never enforced: usage stays 0 forever, checkResourceAccess always allows, and the only symptom is revenue that never arrives. Today every consuming operation happens to be audit:true (registry.ts:89-90, 165-166, 211-212), so the trap is armed but not yet sprung.

Fixpackages/registry/src/derive.ts:368 — change the condition to rule.audit || rule.consumes, so an operation that counts against the plan always emits its event regardless of the audit decision, and let the audit consumer keep filtering on ruleFor(...).audit the way the billing meter already filters on .consumes (services/billing/src/index.ts:75). Alternatively add the invariant to tools/guardrail-check.ts as a registry rule ("consumes implies audit") so the combination is a boot-time refusal rather than a silent no-op — but the derive.ts change is better, because it makes the two flags independent instead of requiring one to imply the other.

medium
A subscription error in serveRpc kills the rpc subject permanently while the process stays up
Bus
packages/transport/src/serve.ts:32
Whenprotocol.js:672-691 parses a server -ERR into a PermissionViolationError and calls subscriptions.handleError(pe), which delivers it to the subscription callback and removes the subscription - it is terminal server-side. serve.ts:32-35 logs one line and returns, without replying and without treating it as fatal. Realistic trigger: an operation is added to the registry and infra/nats/auth.conf (generated, and per its own header hand-edits will disagree) is not regenerated before deploy. The service logs one line at startup and then answers nothing on that subject forever; every caller waits the full timeoutMs and gets SERVICE_UNAVAILABLE with no correlation to the cause. The unsubscribe function serveRpc returns is discarded at all four call sites, so there is no other handle on it.

Fixpackages/transport/src/serve.ts:32-36: respond with args.unreadable when message is present, then make the path fatal - console.error(...); process.exit(1) - since a removed subscription is unrecoverable in-process. Additionally, have each services/*/src/index.ts main() assert after subscribing that subscription.isClosed() is false, or run pnpm exec tsx infra/nats/generate-auth.ts --check in CI as a deploy gate.

NoteVerified the permissions path in node_modules/.pnpm/@nats-io+nats-core*/.../lib/protocol.js:672-691. The --check mode already exists per the auth.conf header, so wiring it into CI is a cheap half of the fix.

medium
No graceful drain of in-flight handlers on SIGTERM; every rolling deploy fails in-flight rpc
Bus
packages/transport/src/serve.ts:37 · reported by 2 auditors (nats-jetstream-reliability, rate-limiting-abuse)
AlsoserveRpc spawns an unbounded number of concurrent handlers

WhenserveRpc runs each delivery inside a detached void (async () => ...) IIFE (serve.ts:37-50) that nc.drain() knows nothing about, and every service's shutdown hook is void closeConnection().then(() => process.exit(0)) (projects/src/index.ts:52-53 and the same three lines in audit, billing, identity), which exits the moment drain resolves. SIGTERM during a rolling deploy with rpc.project.create mid-handler: the subscription drains, message.respond() at serve.ts:40 lands on a draining connection, the gateway waits out its 5s budget and returns SERVICE_UNAVAILABLE - for a project that was in fact created, audited and metered. The user retries and gets CONFLICT on the slug.

Fixpackages/transport/src/serve.ts: keep a module-level Set<Promise<void>>, add the IIFE's promise on entry and delete it in a finally, and export drainInFlight(timeoutMs) that resolves when the set empties or the timeout fires. In each services/*/src/index.ts SIGTERM/SIGINT hook, await drainInFlight(10_000) before closeConnection(), and change the tail to .then(() => process.exit(0), () => process.exit(1)).

NoteMain claim confirmed. Severity lowered from high to medium - the write is not lost, the caller is misinformed about it. One sub-claim is wrong and I removed it from the fix rationale: void closeConnection().then(...) does not hang until SIGKILL if drain() rejects; Node >=15 turns the unhandled rejection into a crash with a non-zero exit. The .then(ok, err) change is still right because a crash exit is not a clean shutdown.

medium
A renamed or newly created durable replays the entire retention window from sequence 1
Bus
packages/transport/src/serve.ts:67
WhenThe consumer config (serve.ts:67-73) sets no deliver_policy, so JetStream defaults to DeliverAll. Durable names for commands are derived from registry strings - identity-${route.resource}-${route.operation} (identity/src/index.ts:213) - and the meter's is the fixed 'billing-meter'. Delete a stuck consumer to unblock an incident, rename a resource in the registry, or stand up the billing service for the first time against a populated EVT stream, and the new durable replays 30 days of events from sequence 1: billing.track fires again for every consumed unit in the window, silently multiplying every customer's usage. Audit survives on its unique requestId; the meter does not.

FixAdd an explicit deliver_policy to the consumer config in packages/transport/src/serve.ts:67-73 - accept it as an argument so consume() callers choose - and set DeliverNew for the evt.> consumers in services/billing/src/index.ts and services/audit/src/index.ts. Keep DeliverAll only once the meter carries a persistent per-requestId dedupe key. Document in .claude/skills/jetstream-service/SKILL.md that renaming a durable is a full replay, not a rename.

NoteConfirmed - deliver_policy is absent from the config object. DeliverNew is the wrong default for audit, which should not skip a backlog, so the fix must be per-caller rather than a blanket change in serve.ts.

medium
consumers.add is called with action Create inside a bare catch, so consumer config drift is silently permanent
Bus
packages/transport/src/serve.ts:74
Whenjsmconsumer_api.js:139-148 shows add() defaults to ConsumerApiAction.Create, so the server returns a 400 whenever the durable exists with a different config. The bare catch {} at serve.ts:76-78 discards precisely the case its comment claims to have excluded. You raise max_deliver from 5 to 20 to fix the dropped-command bug, deploy, see no error, and the durable created on day one keeps running with max_deliver 5 - commands keep being dropped with no signal. The same catch also hides 'stream not found' (bootstrap never run) and a $JS.API.CONSUMER.CREATE permissions violation.

Fixpackages/transport/src/serve.ts:74-78: call await manager.consumers.info(args.stream, args.durable) first (the identity/billing/audit nkeys already allow $JS.API.CONSUMER.INFO.<STREAM>.*); on a not-found error call add, and when it exists compare max_deliver/ack_wait/filter_subject/ack_policy/deliver_policy against config and call manager.consumers.update(...) on any difference. Let every other error propagate to the fatal consume() handler.

NoteVerified against jsmconsumer_api.js:139-153. Severity lowered from high to medium: the consequence is 'your fix does not apply, silently', i.e. operational pain amplifying other findings, not an independent outage. Note the fix is permission-safe - addUpdate uses $JS.API.CONSUMER.CREATE.<stream>.<name> for updates too, which the generated allow-lists already cover via CONSUMER.CREATE.CMD.> / .EVT.>.

medium
Consumer creation failures are swallowed, so config changes never take effect and a missing stream looks like a healthy boot
Bus
packages/transport/src/serve.ts:76
Whentry { await manager.consumers.add(args.stream, config) } catch { /* Already exists with this config. */ } discards every error. (1) Change max_deliver or ack_wait in serve.ts and deploy: consumers.add fails with a config conflict, the error is dropped, and the durable keeps the old settings forever with no log line. (2) pnpm nats:bootstrap was never run in a new environment: add fails because the stream does not exist, then stream.consumers.get at line 81 rejects - and because services/audit/src/index.ts:49 and services/projects/src/index.ts:33 call void consume({...}), that rejection never reaches main().catch, so the service prints '[audit] consuming evt.>' and looks healthy while consuming nothing.

FixIn packages/transport/src/serve.ts inspect the error and call manager.consumers.update(args.stream, args.durable, config) on a config conflict, rethrow anything else, and in every services/*/src/index.ts await the consume setup (have consume() resolve once the consumer is bound and expose the loop separately) so a bootstrap failure fails main() before the success log.

NoteBoth halves verified, including the void consume(...) swallow at services/audit/src/index.ts:49, services/billing/src/index.ts:67, services/identity/src/index.ts:211 and services/projects/src/index.ts:33.

medium
An audit event is dropped after five failed deliveries with no dead-letter
Bus
packages/transport/src/serve.ts:91
WhenConfirmed. consume() sets max_deliver: 5 (serve.ts:71) and on a handler throw naks with a 2000ms delay (line 91) under a comment claiming the message 'lands on the stream's dead letter'. packages/transport/src/streams.ts:19-27 builds every stream from name/subjects/description/max_age/duplicate_window only — there is no DLQ stream, and nothing anywhere subscribes to $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES. So five attempts over roughly eight seconds is the entire budget: a ~10s Postgres blip (failover, pool exhaustion, or the uncaught pool 'error' crash above) makes auditService.record throw five times and the event is abandoned. The mutation happened and the billing meter counted it, but the audit row does not exist; audit_log ids are crypto.randomUUID() and there is no sequence, so the gap is undetectable.

FixFor the audit durable specifically, raise max_deliver and use a long backoff (parameterise consume() in packages/transport/src/serve.ts so services/audit/src/index.ts can pass its own), and add a DLQ stream in packages/transport/src/streams.ts on $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>. Distinguish transient (SQLSTATE 08*, 57P03) from permanent in the audit handler so only genuinely unprocessable payloads are dropped.

NoteThe dead-letter comment at line 90 is verifiably false against streams.ts. Medium is right: it needs a multi-second database outage to trigger, but the loss is silent and the product sells the trail as immutable.

medium
duplicate_window of 2 minutes against a 7-day command stream lets a redelivered command re-emit its event
Bus
packages/transport/src/streams.ts:26
Whenduplicate_window is hardcoded to 2 minutes (streams.ts:26) while CMD retention is 7 days (derive.ts:333) and EVT 30 days. publishEvent uses msgID <requestId>:evt (request.ts:117), so re-emission is deduped only inside those 2 minutes. Sequence: identity commits the invitation for cmd.member.create then crashes before ack; ack_wait (30s) expires; the pod sits in CrashLoopBackOff for 3 minutes; delivery #2 runs, the check-then-skip at identity/src/index.ts:61-64 correctly returns accepted without a second invitation, and service.ts:280-286 then publishes evt.member.create again - now outside the window, so EVT genuinely holds the event twice and billing meters a second seat.

FixAdd duplicateWindowMinutes to StreamConfig in packages/registry/src/derive.ts:321-326 (CMD sized to the redelivery horizon you choose in the backoff fix, e.g. 60) and read it in packages/transport/src/streams.ts:26 instead of the constant. Note the server holds the dedupe index in memory, so size it deliberately. This narrows but does not close the race - the meter's dedupe key is the real fix.

NoteConfirmed as written; the finding correctly says a wider window only narrows the race. Severity lowered from high to medium: the only consequence that survives is double-metering, which is already the subject of the (higher-severity) idempotency finding - audit is protected by its unique requestId.

medium
bootstrap-streams falls through to streams.update on any add failure, silently rewriting live stream config
Bus
packages/transport/src/streams.ts:28
Whenstreams.add is wrapped in a catch-all that unconditionally calls streams.update (streams.ts:28-34), so a permissions error, a timeout or a brief NATS outage all become an update attempt whose failure message points at the wrong problem. jsmstream_api.js:367-384 confirms update() merges the supplied fields over the live config, and the three fields this code always sends are subjects, max_age and duplicate_window. Lowering CMD maxAgeDays from 7 to 1 in derive.ts:333 and running pnpm nats:bootstrap immediately expires every pending command older than a day, unprompted and unlogged, with no way back.

Fixpackages/transport/src/streams.ts: call await manager.streams.info(stream.name) first and branch on existence rather than catching (the bootstrap nkey already allows $JS.API.STREAM.INFO.CMD/EVT). When the stream exists, print the field-by-field diff, and refuse to reduce max_age or remove a subject unless an explicit force flag is threaded through from scripts/bootstrap-streams.ts.

NoteBoth halves verified, including the merge semantics in jsmstream_api.js:367-384. The proposed streams.info() fix is permission-safe under the generated bootstrap user.

medium
components.json aliases point at subpaths the package does not export, so pnpm ui:add produces broken files
Client mirror
packages/ui/components.json:14
WhenVerified: root package.json:27 wires ui:add to shadcn inside packages/ui and SKILL.md documents pnpm ui:add dialog dropdown-menu select. components.json:13-15 sets the components/utils/ui aliases under @guardrail/ui/src/…, but packages/ui/package.json exports only "./*": "./src/components/ui/*.tsx", "./lib/utils" and the named gate paths. @guardrail/ui/src/lib/utils therefore resolves through the catch-all to ./src/components/ui/src/lib/utils.tsx, which does not exist. Every hand-written component avoids this with a relative import (button.tsx:4, input.tsx:3, card.tsx:3, badge.tsx:4, table.tsx:3), so the breakage appears only for generated files.

FixEither point components.json at the exported paths ("utils": "@guardrail/ui/lib/utils") or add "./src/*": "./src/*" to the exports map in packages/ui/package.json. Also add "paths": { "@guardrail/ui/*": ["./src/*"] } to packages/ui/tsconfig.json — it currently declares no paths at all, and the shadcn CLI resolves aliases through tsconfig paths, so it cannot map the alias to a directory either.

NoteConfirmed with two corrections: the failure mode is ERR_MODULE_NOT_FOUND via the "./*" catch-all rather than ERR_PACKAGE_PATH_NOT_EXPORTED, and the missing tsconfig paths entry is the more immediate blocker for the CLI itself.

medium
ViewerContext's default fabricates free-plan entitlements when no provider is mounted
Client mirror
packages/ui/src/components/viewer.tsx:21
WhenVerified: createContext is seeded with {entitlements: EMPTY_ENTITLEMENTS, permissions: [], role: "member"} rather than a sentinel. Any client component rendered outside (dashboard)/layout.tsx — a portalled modal, the existing apps/web/src/app/onboarding segment (which has no ViewerProvider), a future /settings route — reads free-plan, zero-usage entitlements with no error, so a bare <PriceGate resource="member"> there renders the invite form as if 2 seats were free. Nothing looks wrong; the mirror just answers wrong.

Fixpackages/ui/src/components/viewer.tsx: createContext<ViewerState | null>(null) and make useViewer() throw new Error("useViewer outside ViewerProvider — mount it in app/(dashboard)/layout.tsx") on null. Every gate funnels through useViewer, so this converts a silent wrong answer into a boundary error caught by the new (dashboard)/error.tsx.

NoteSeverity lowered from high to medium and half the scenario is wrong: "member" is the LOWEST role in ROLE_RANK, so AuthGate fails closed outside the provider (roleAtLeast("member","admin") is false) — it cannot 'render owner-facing UI'. Only role="member" gates pass, which every real user passes anyway. The entitlements half is the real defect and it does fail open. Latent today: no component outside the provider currently calls a gate.

medium
The client mirror's usage never refreshes after a mutation, so the button stays enabled past the limit
Client mirror
packages/ui/src/components/viewer.tsx:22
WhenViewerProvider is populated once per server render in apps/web/src/app/(dashboard)/layout.tsx:26 from the 30s-cached entitlements, and useUsageLabel / PriceGate / useAccess all read that frozen snapshot (viewer.tsx:31, price-gate.tsx:23, feature-gate.tsx:71). A free user creates project 1 and 2 from apps/web/src/features/projects/project-list.tsx: onSuccess (line 37-40) invalidates only trpc.project.list, which does not re-run the server layout, so the header still reads "0 of 2", the Create button stays enabled, and the third click returns a raw UPGRADE_REQUIRED message rendered as plain destructive text (project-list.tsx:72). That is precisely the button-versus-endpoint disagreement the mirror exists to prevent, and it happens in the first session of every new account.

Fixapps/web/src/gateway/routers/billing.router.ts already exposes billing.overview, which returns entitlements. Have ViewerProvider hydrate from a trpc.billing.overview query seeded with initialData from apps/web/src/app/(dashboard)/layout.tsx:38, then invalidate that query key in the onSuccess of any mutation whose operation is consumes — a single helper in apps/web/src/trpc/react.tsx keyed off ruleFor(resource, operation).consumes keeps it derived rather than written per feature. Note billing.read is minRole admin (registry.ts:280), so a plain member cannot call it — keep the layout-provided value as the fallback for members.

NoteConfirmed. Sharpened the fix with the billing.read admin-only constraint, which the original missed and which would have broken the viewer for members. Note the underlying usage would still lag because metering is asynchronous — this fix removes the stale-snapshot half only.

medium
The root .env the quick start tells you to create is loaded by no process
Repo
README.md:47
WhenREADME.md:47 says cp .env.example .env # BETTER_AUTH_SECRET and ENVELOPE_SECRET are required, but nothing reads that file. Next.js loads env files relative to the app directory it is invoked in (apps/web), which is why line 48 tells you to copy creds into apps/web/.env.local; the four services pass exactly one --env-file=../../infra/nats/creds/<service>.env (services/*/package.json:7) and tsx loads no .env by default; turbo lists .env only in globalDependencies (turbo.json:4), which affects hashing, not the child environment. Result: on a fresh clone following the documented quick start, make dev boots the services and env.envelopeSecret() at services/projects/src/index.ts:19 throws 'Missing required environment variable ENVELOPE_SECRET' - and, worse for a real deployment, there is no documented mechanism at all by which ENVELOPE_SECRET reaches both the gateway and the services with the same value.

FixEither add a second --env-file=../../.env to the dev/start scripts in every services/*/package.json (node/tsx accept repeated --env-file) and document that Next reads apps/web/.env.local, or drop the root .env from the quick start and give each process an explicit env file; state the ENVELOPE_SECRET-must-match requirement in .env.example beside the variable.

medium
Audit retention declared in the registry (pro: 90) is never enforced — rows are kept forever and the number means two things
Audit
services/audit/src/audit.service.ts:19
WhenConfirmed on the main claim. auditService (audit.service.ts:18-47) has record() and list() and no delete of any kind; no scheduled job, no consumer and no migration prunes audit_log. registry.ts:318 declares auditLog limits {free:false, pro:90, scale:"unlimited"} and the upgrade copy at :321-324 sells retention, but limits is only read by checkResourceAccess (derive.ts:266) and usageLabel (:285), both of which interpret the number as a count of used units. So a pro tenant's history is never truncated, the table grows without bound across every tenant, and the billing page renders auditLog as "0 of 90" — a unit count, not days.

FixGive retention its own field rather than overloading limits: add retentionDays?: Readonly<Record<PlanKey, number | "unlimited">> to ResourceDefinition in packages/registry/src/define.ts, declare it on auditLog in registry.ts, and add a prune to services/audit/src/audit.service.ts driven by a scheduled call in services/audit/src/index.ts that deletes rows older than the window. Per-org plan is on every envelope as meta.plan and can be re-read from billing for the sweep.

NoteMain claim confirmed. One sub-claim refuted: "if auditLog.read were plan-gated it would refuse reads after 90 rows" cannot happen — auditLog.featureId is null (registry.ts:307) and readUsage skips null featureIds (autumn.adapter.ts:53-54), so usage.auditLog is never populated and used is always 0. Severity medium, driven by unbounded table growth rather than by the mis-sold retention.

medium
The declared audit retention limit (pro: 90) is enforced nowhere — pro and scale are identical and the table grows forever
Audit
services/audit/src/audit.service.ts:35 · reported by 2 auditors (plan-gating-billing, ops-observability-config)
AlsoThe audit retention limit the plans sell is enforced by nothing, and audit_log grows without bound

Whenpackages/registry/src/registry.ts:318 declares auditLog.limits = { free: false, pro: 90, scale: "unlimited" } and the upgrade copy at line 321-324 explicitly sells it as retention ("Audit history is not included in your plan. Scale keeps it"). But auditService.list (services/audit/src/audit.service.ts:35-47) filters only on organizationId and optional resource, with no createdAt cutoff, and there is no pruning job anywhere in services/audit. A Pro org ($29) that has been running two years gets its full two-year history, identical to Scale ($99) — the differentiator the higher tier is sold on does not exist, and the audit_log table grows without bound. Grep confirms limitFor is called only from checkResourceAccess/usageLabel/isInPlan in derive.ts; nothing in services/audit imports the registry limits at all. Worse, the same 90 is fed to checkResourceAccess as a *count* (derive.ts:279, used + requested > limit) and to usageLabel (derive.ts:290), so the billing page renders "Audit log: 0 of 90" — a days value displayed as a quota.

FixTwo parts. (1) services/audit/src/audit.service.ts:35 — add a retention cutoff to list: take retentionDays from the handler (services/audit/src/index.ts can compute limitFor("auditLog", ctx.plan) from @guardrail/registry using the plan already in the signed envelope) and add gte(auditLog.createdAt, cutoff) to the where clause when the limit is a number. Add a matching delete-older-than job for storage. (2) packages/registry/src/define.ts — the Limit type is carrying two incompatible meanings (a countable quota and a retention window) through one field; either add a limitUnit: "count" | "days" to ResourceDefinition and have usageLabel (derive.ts:285) phrase days as days, or move retention to its own field so checkResourceAccess is never handed a days value.

medium
audit_log.metadata is never written — the compliance trail cannot say which row was affected
Audit
services/audit/src/index.ts:53
WhenThe audit_log table declares metadata: jsonb('metadata').$type<Record<string, unknown>>() (services/audit/src/schema.ts:21) and auditService.record accepts an optional metadata argument (audit.service.ts:27), but the only caller — the evt.> consumer at services/audit/src/index.ts:54-62 — passes organizationId/actorId/actorRole/resource/operation/outcome/requestId and no metadata, so the column is NULL on 100% of rows. The reason is structural: the event body is eventPayload = z.object({ outcome: z.enum(EVENT_OUTCOMES) }) (packages/contracts/src/envelope.ts:111) and packages/guardrail/src/service.ts:285 publishes exactly { outcome: 'success' }. So an owner deletes project X and the trail records only 'project.delete succeeded by user U' — the audit page (auditContract output has no metadata field either) cannot answer which project, what its name was, or what an update changed. That is the core question a compliance audit asks, and the data to answer it is not stored anywhere else because the project row is gone. Additionally EVENT_OUTCOMES contains only 'success', so every audit_log.outcome is the constant 'success' and denials/failures are never recorded.

FixWiden eventPayload in packages/contracts/src/envelope.ts:111 to { outcome, subjectId?: string, changed?: string[] }, have packages/guardrail/src/service.ts build it from the handler's returned data (every mutation contract returns a dto with an id), pass metadata: payload through at services/audit/src/index.ts:55, and add the field to auditContract's output in packages/contracts/src/resources/audit.contract.ts. Note the payload is covered by signEvent, so this stays tamper-evident.

medium
Audit retention is sold in the registry (90 days on pro) but nothing ever deletes an audit_log row
Audit
services/audit/src/schema.ts:10
WhenConfirmed. packages/registry/src/registry.ts:318 declares auditLog limits { free: false, pro: 90, scale: 'unlimited' } and the upgrade copy sells retention. services/audit/src/audit.service.ts has exactly two functions, record (29) and list (35) — no delete, no purge; there is no scheduler entry point in services/audit/src/index.ts and no partitioning in schema.ts. The evt.> consumer at index.ts:49 writes for every org including free-plan ones whose auditLog.read the plan gate refuses (limit false -> not_in_plan), so the product stores compliance data for customers it has contracted not to retain, and the 90-day promise on pro is enforced nowhere.

FixAdd purge(args: { organizationId: string; olderThan: Date }) to services/audit/src/audit.service.ts and a scheduled entry in services/audit/src/index.ts that walks orgs, resolves limitFor('auditLog', plan) from the registry and deletes beyond it (dropping rows entirely when the limit is false). If volume warrants, declare audit_log monthly-partitioned in services/audit/src/schema.ts and drop partitions instead.

NoteVerified the absence of any delete path and the plan declaration. Medium is right — a compliance/cost problem that grows, not an immediate failure.

medium
Audit list filtered by resource has no supporting index
Audit
services/audit/src/schema.ts:24
WhenConfirmed: line 24 declares the only non-unique index, (organization_id, created_at); requestId carries a unique index from .unique() at line 20. audit.service.ts:36-45 builds WHERE organization_id = $1 AND resource = $2 ORDER BY created_at DESC LIMIT n (n <= 200 per packages/contracts/src/resources/audit.contract.ts). Postgres walks the org's rows newest-first on the existing index and discards non-matching resources; for an org with millions of rows of which few are the filtered resource, the LIMIT is satisfied only near the end of history. auditLog.read has a 4000ms budget (registry.ts:314) so the compliance page returns DEADLINE_EXCEEDED.

FixAdd index('audit_org_resource_created_idx').on(table.organizationId, table.resource, table.createdAt) to the index array in services/audit/src/schema.ts:24 and commit the migration; keep the existing org+created index for the unfiltered path.

NoteCorrect as stated, but the impact is entirely contingent on the retention finding above — with a working purge the table stays small enough that the existing index suffices. Medium kept only because retention is also absent.

medium
No reconciliation on downgrade or refund: usage above the new limit is left in place and never surfaced
Billing
services/billing/src/index.ts:66
Whenservices/billing/src/index.ts consumes only evt.> for metering (lines 67-78); nothing consumes an Autumn or Stripe plan-change signal, and no webhook route exists. A Scale org (project limit "unlimited", registry.ts:186) with 400 projects downgrades to Free (limit 2): checkResourceAccess refuses new creates and that is the entire consequence. All 400 projects stay readable, editable and served forever on a free plan. The reverse is equally silent — a refund or a failed renewal moves the customer back to free with no notification, no grace period and no read-only mode, and the customer discovers it as an unexplained UPGRADE_REQUIRED on their next create.

Fixservices/billing/src/index.ts — add a plan-change consumer fed by the Autumn webhook route from the previous finding, publishing an evt the owning services can act on (projects archiving beyond the new limit, or flagging the org read-only) and recording the overage. If the decision is deliberately to do nothing, write that decision as a NOTE beside the checkResourceAccess call in packages/guardrail/src/gateway.ts:181-186 and in the billing service header — in this codebase an undocumented omission and a decision are indistinguishable, which is the failure mode superseded.ts exists to prevent.

NoteConfirmed as an omission across the billing service and the app's api routes. Medium is right — it is revenue leakage and a support-surprise, not an immediate outage.

medium
No unique constraint on invitation(organization_id, email) and no expiry filter — concurrent invites duplicate and an expired invite blocks re-inviting
Identity
services/identity/src/identity.service.ts:51
WhenConfirming and merging the auditor's invitation finding with the piece they were right about. identityService.invitations (51-57) filters organizationId AND status = 'pending' and never compares expiresAt; createInvitation (59-78) sets a 48h expiry that no query in the repo reads (grep: expiresAt appears only at that write and in the column declaration). services/identity/src/index.ts:61-64 uses that list as the idempotency key for member.create. So an invitation created three months ago and never accepted still has status 'pending', and every subsequent invite to that address returns {accepted: true} without inserting or emitting anything — the admin sees success, the invitee never receives an email, and the dead row sits in the invitations UI forever. Separately, neither schema copy declares any index on invitation, so two concurrent member.create commands to the same address both read an empty list and insert two rows (member.create is a durable command with at-least-once delivery, making the concurrent case likely rather than exotic).

FixIn services/identity/src/identity.service.ts add gt(invitation.expiresAt, new Date()) to the where clause at line 55 (import gt on line 12); add (table) => [uniqueIndex('invitation_org_email_idx').on(table.organizationId, table.email), index('invitation_org_status_idx').on(table.organizationId, table.status)] to the invitation table in packages/auth/src/schema.ts:83; and make createInvitation an upsert with .onConflictDoUpdate on that index refreshing expiresAt/status so a re-invite after expiry works and a redelivered command is idempotent at the database rather than in a racy read.

medium
A command refused for business reasons is redelivered five times after the browser was already told it was accepted
Identity
services/identity/src/index.ts:217 · reported by 2 auditors (multitenancy-authz, nats-jetstream-reliability)
AlsoThe command consumer throws on every non-ok reply, so permanent refusals are retried five times and then dropped

Whenif (!reply.ok) throw new Error(reply.error.message) fires for every refusal code defineService can return, including permanent ones: UNTRUSTED_ENVELOPE (bad signature - service.ts:233), PERMISSION_DENIED (:198), INVALID_INPUT (:79) and CONFLICT. An envelope with a bad signature published onto cmd.member.create is therefore re-executed 5 times over 10 seconds before being terminated, while a genuinely transient INTERNAL from a database blip gets exactly the same 10-second budget. The consumer cannot tell poison from transient, so it retries what it must not and gives up on what it should. This directly contradicts defineConsumer's own policy at service.ts:322-323 ('a message that fails any check here is dropped rather than thrown, so JetStream acks it instead of redelivering forged bytes five times').

FixIn services/identity/src/index.ts:215-218 and the identical block in services/projects/src/index.ts:37-40, branch on reply.error.code: throw (nak, retry) only for INTERNAL / SERVICE_UNAVAILABLE / DEADLINE_EXCEEDED, and for every other code log once and return so serve.ts:87 acks and terminates the message immediately. Better, export the retryable set from packages/contracts/src/errors.ts so both services and any future command consumer share one list.

medium
The last-owner invariant is a read-then-write with no transaction or row lock
Identity
services/identity/src/index.ts:29 · reported by 2 auditors (database-data, multitenancy-authz)
AlsoassertNotTheLastOwner is a read-then-write with no locking — two concurrent leaves or demotions both pass

WhenConfirmed as a race. assertNotTheLastOwner (:29-39) does an unlocked SELECT via identityService.members and compares owners.length <= 1; the subsequent removeMember (identity.service.ts:43) and setMemberRole (:108) run in separate implicit transactions with no SELECT ... FOR UPDATE and no DB constraint behind the rule. Two owners A and B leaving within the same instant on two identity replicas both read owners.length === 2, both pass, both delete: zero owners, the exact state the function exists to prevent. Same between two demotions, and between a demotion and a leave. A single owner double-clicking Leave is *not* a trigger — the second call finds no membership row and gets NOT_FOUND.

FixMove the check inside the write in services/identity/src/identity.service.ts: add removeMemberGuardingLastOwner / setMemberRoleGuardingLastOwner that open db.transaction, run SELECT id FROM member WHERE organization_id = $1 AND role = 'owner' FOR UPDATE, and perform the delete/update in the same tx, throwing ServiceError("CONFLICT", ...) from inside it. Have services/identity/src/index.ts call those in place of assertNotTheLastOwner + removeMember/setMemberRole (and use them for the member.delete fix above too, so all three paths share one atomic guard).

NoteConfirmed. Severity lowered from high to medium: it needs two distinct owners acting within milliseconds on separate replicas, whereas finding #1 reaches the same end state with one click and no race — fix #1 first, then close this.

medium
Invitation creation is a check-then-insert with no unique constraint — two replicas produce duplicate invitations and double-count seats
Identity
services/identity/src/index.ts:61
WhenPartly confirmed, with a narrower trigger than claimed. index.ts:61-64 reads identityService.invitations(ctx.orgId) and then inserts; the invitation table (schema.ts:36-44) has no unique index on (organization_id, email). The *redelivery* half of the scenario is refuted: publishCommand sets msgID = requestId (transport/request.ts:109) against a 2-minute duplicate_window (transport/streams.ts:26), and consume() awaits each handler in a sequential for-await loop (transport/serve.ts:84-92), so one replica cannot process two deliveries concurrently. What does hold: two different invites for the same address (two requestIds, so no msgID dedupe) landing on two identity replicas concurrently — which is the intended production shape, since the service runs under a queue group and a CMD durable. Both see no pending row, both insert, two evt.member.create fire with different requestIds, the billing meter counts two seats for one person, and the invitee gets two emails.

FixAdd a partial unique index on invitation(organization_id, email) WHERE status = 'pending' in services/identity/src/schema.ts, and rewrite identityService.createInvitation in services/identity/src/identity.service.ts as an insert with .onConflictDoNothing() returning the existing row, so the handler's idempotency is a database guarantee rather than a read-then-write. Keep the handler's early-return shape so a duplicate still answers accepted.

NoteConfirmed but re-scoped: the JetStream-redelivery trigger is refuted (msgID dedupe + sequential consumer loop); the multi-replica concurrent-invite trigger is real. Deployment condition: more than one identity replica. Severity medium stands.

medium
Seats are metered per invitation sent, not per seat held, and the duplicate-invite short circuit meters again
Identity
services/identity/src/index.ts:62
Whenmember.create is consumes: true with featureId seats (registry.ts:196, 207-214). services/identity/src/index.ts:61-64 dedupes a repeated invite for the same email and returns accepted without creating anything — but packages/guardrail/src/service.ts:280-286 publishes evt.member.create after every non-throwing handler run, and the publish-side msgID is ${requestId}:evt (packages/transport/src/request.ts:117), so a second invite with a fresh requestId is a distinct message and meters another seat while creating no invitation. member.delete is consumes:false so removing a person decrements nothing, and organization/accept-invitation is deliberately left open (superseded.ts KEPT, line 86-87) so seats gained that way are never metered at all. A free org (2 seats) can read "Seats 5 of 2" with one person in the list and be unable to invite anybody, while an org that only accepts invitations can exceed its seat count entirely.

FixMeter seats from the truth rather than the intent. services/identity/src/index.ts:61-64 — return the dedupe result in a way the runtime can see (e.g. throw new ServiceError("CONFLICT", ...) for an already-pending invite, which packages/guardrail/src/service.ts:303 turns into a reject and suppresses the event) so a duplicate invite meters nothing. Then publish the authoritative seat count after member add/remove and have services/billing/src/index.ts call billing.setUsage (an absolute set) instead of track — which also closes the accept-invitation gap without moving that endpoint. Requires the setUsage fix below.

NoteConfirmed, including the event-on-dedupe path through service.ts:280. The original said the 2-minute publish dedupe window does not cover it; verified — the msgID is derived from requestId, so two different requests are two different messages regardless of window.

medium
No notifier consumes evt.member.create, so the invitation is created, billed and never delivered
Identity
services/identity/src/index.ts:72
WhenThe comment claims 'a notifier consumes evt.member.create'. None of the four consume() call sites filters on a member subject. An owner invites a teammate: gateway publishes cmd.member.create, identity writes an invitation row with a 48h expiry (identity.service.ts:73), emits the event, audit records it, billing meters a seat - and no email is ever sent. The invitation expires 48h later. The UI showed {accepted:true}, so nothing surfaces the gap, and the org is metered for a seat that was never usable.

FixEither implement the notifier (a consumer in services/identity/src/index.ts bound to eventSubject('member','create') via defineConsumer, keyed on the invitation id for idempotency - which needs $JS.API.CONSUMER.CREATE.EVT added for the identity nkey in infra/nats/generate-auth.ts), or delete the claim at services/identity/src/index.ts:72. Longer term, a boot-time assertion in packages/guardrail/src/service.ts that every route with event !== null has a declared consumer would make this class of gap fail on make dev.

NoteConfirmed - the consumer genuinely does not exist. Severity lowered from high to medium: this is an unimplemented feature in a boilerplate rather than a reliability regression, but the false comment plus the metered seat make it a real production gap, so it stays above low.

medium
Invitation idempotency is check-then-insert with no unique constraint behind it
Identity
services/identity/src/schema.ts:36
WhenThe invitation table (schema.ts:36-44) has no unique index on (organization_id, email), and the handler reads all pending invitations then inserts (identity/src/index.ts:61-70, identity.service.ts:59-78). Two concurrent deliveries - ack_wait expiring while the first handler still runs, or two identity replicas sharing the durable after a redelivery - both see no existing row and both insert. Two invitation rows, two seats metered. Separately, identityService.invitations filters status = 'pending' (identity.service.ts:55), so a redelivery arriving after the invite was revoked silently recreates it.

FixAdd uniqueIndex('invitation_org_email_idx').on(table.organizationId, table.email) (partial on status='pending' if revoked rows are retained) to services/identity/src/schema.ts:36-44, generate the migration, and change createInvitation in services/identity/src/identity.service.ts:65-77 to .onConflictDoNothing() returning the existing row - the same shape audit already uses at services/audit/src/audit.service.ts:32.

NoteConfirmed against both files, and .claude/skills/jetstream-service/SKILL.md:84-86 prescribes exactly the unique-column pattern that identity does not have. Note revokeInvitation is a hard DELETE (identity.service.ts:80-86), so a plain unique index is sufficient - no partial index is actually needed today.

medium
Shutdown drains NATS and exits immediately, abandoning in-flight work and never closing the pg pool
Projects
services/projects/src/index.ts:52
Whenprocess.on("SIGTERM", () => void closeConnection().then(() => process.exit(0))), identical in all four services. closeConnection calls nc.drain(), which unsubscribes and closes; the consume loop at packages/transport/src/serve.ts:84 is never stopped first, so a handler mid-transaction has its message.ack() (line 87) run against a closed connection - the ack is lost and JetStream redelivers on the next boot. In-flight rpc handlers lose their message.respond too, so callers time out (4s of held gateway request) instead of seeing a clean refusal. The pg Pool from packages/db/src/index.ts is never ended, so backends linger for the whole grace period, and if the connect promise was rejected the .then(process.exit(0)) never fires at all and the pod waits for SIGKILL.

FixGive each services/*/src/index.ts a shutdown() that (1) calls the unsubscribe function serveRpc already returns, (2) breaks the consume loop after the current ack via a stop flag returned from packages/transport/src/serve.ts, (3) awaits in-flight handlers with a deadline, then (4) awaits closeConnection() in a try/catch and a new closePools() exported from packages/db/src/index.ts.

NoteConfirmed, with one correction: only member.create is transport: "command" (registry.ts:210) and it IS idempotent (identity/index.ts:61-64 checks for an existing invitation), so the 'projects create runs twice' example is wrong - project.create is rpc. The dropped-reply and un-drained-pool consequences stand.

medium
Unique-constraint violations surface as INTERNAL 500 instead of CONFLICT
Projects
services/projects/src/project.handlers.ts:30
WhenConfirmed for projects. project.handlers.ts:30-33 does bySlug-then-insert; project_org_slug_idx (services/projects/src/schema.ts:28) is a unique index, so two concurrent creates of the same slug (a double-clicked form, or a retried request) both read null and the loser's INSERT raises 23505. That is not a ServiceError, so packages/guardrail/src/service.ts:307-308 logs it and returns INTERNAL 'The service failed to handle this request', which the gateway maps to a 500 — for the same condition the line above returns a clean CONFLICT.

FixAdd isUniqueViolation(error) to packages/contracts/src/errors.ts (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') and wrap the insert in services/projects/src/project.service.ts#create (and identity.service.ts#createOrganization) to rethrow new ServiceError('CONFLICT', ...), demoting the pre-check to an optimisation.

NoteMain claim confirmed, but one sub-claim is REFUTED: the auditor wrote that identity's organization slug 'has no unique index behind it in the identity copy of the schema at all'. services/identity/src/schema.ts:15 is slug: text('slug').notNull().unique() — it does. Severity kept medium; the real-world trigger is a double-click, and the outcome is a confusing 500 plus error-log noise, not corruption.

medium
Projects list cursor is a millisecond-truncated createdAt with a strict <, silently dropping rows
Projects
services/projects/src/project.service.ts:37
WhenBoth halves verified. (a) services/projects/src/schema.ts:24 is timestamp('created_at') — Postgres microsecond precision. drizzle-orm/pg-core/columns/timestamp.js mapFromDriverValue does new Date(value + '+0000'), and node-postgres hands drizzle the raw string (drizzle-orm/node-postgres/session.js:30 overrides the TIMESTAMP type parser to identity), so a row at 12:00:00.123456 becomes a JS Date truncated to .123. project.service.ts:37 emits that via toISOString(); line 26 then filters lt(project.createdAt, new Date(cursor)) = strictly < .123000. Every row in (.123000, .123456] belongs on page 2 under desc(createdAt) and is skipped permanently. (b) Independently, lt drops all ties: 30 bulk-imported projects sharing one created_at with limit 20 lose 10 rows while hasMore says there is another page. No error is surfaced.

FixIn services/projects/src/project.service.ts encode a composite cursor (${row.createdAt.getTime()}:${row.id}), order by desc(project.createdAt), desc(project.id), and filter with or(lt(createdAt, ts), and(eq(createdAt, ts), lt(id, cursorId))); extend project_org_created_idx in services/projects/src/schema.ts:29 to (organizationId, createdAt, id). Note the ms-truncation half disappears only if the column also becomes timestamptz or the cursor carries the raw string — encoding getTime() alone still truncates, so pair this with the timezone/precision fix.

NoteDowngraded high -> medium. Both mechanisms are real and I verified the drizzle truncation path, but the loss requires two rows inside one millisecond at a page boundary (bulk import, seed, or a burst), which is an edge case rather than a load-bearing failure. The auditor's proposed getTime() cursor does not actually fix half (a); sharpened above.

medium
defaultNow() writes into timestamp without time zone using the session TimeZone while application writes are UTC
Projects
services/projects/src/schema.ts:24
WhenMechanism verified in the installed driver. Every timestamp column in services/{projects,identity,audit}/src/schema.ts and packages/auth/src/schema.ts is plain timestamp(...) (getSQLType in drizzle-orm/pg-core/columns/timestamp.js emits 'timestamp' with no ' with time zone' when withTimezone is false, which is the default). drizzle-orm/node-postgres/session.js:30 replaces the TIMESTAMP parser with identity so drizzle receives the raw string and mapFromDriverValue does new Date(value + '+0000') — i.e. it reads the column as UTC unconditionally. mapToDriverValue writes value.toISOString() — also UTC. But defaultNow() emits now(), a timestamptz, cast into a without-tz column using the session's TimeZone. On a deployment whose Postgres or connection TimeZone is not UTC, created_at is stored in local time and read back as UTC: project rows appear updated before they were created (project.service.ts:91 writes updatedAt as an app-side UTC Date), the projects cursor window shifts by the offset, and invitation expiresAt (app-written UTC, identity.service.ts:73) is off by the offset relative to created_at.

FixChange every timestamp column in services/*/src/schema.ts and packages/auth/src/schema.ts to timestamp('...', { withTimezone: true }) and regenerate; timestamptz makes now() and toISOString() agree regardless of session TimeZone (and gives the cursor a precision-safe representation). If the type change is too invasive, add options: '-c timezone=UTC' to the Pool literal in packages/db/src/index.ts:24 — but note that only fixes processes going through that factory.

NoteThe code mechanism is CONFIRMED (I read both the drizzle column implementation and the node-postgres type-parser override). Whether it bites depends on the deployed Postgres/session TimeZone, which I cannot check from this repo — infra/docker-compose.yml runs stock postgres:16-alpine, which is UTC, so it will never reproduce locally. Hence PLAUSIBLE, and that invisibility-in-dev is exactly what makes it worth fixing.

medium
No consumer for evt.organization.delete: projects rows outlive the organisation forever
Projects
services/projects/src/schema.ts:8
WhenThe header promises 'Referential integrity across services is enforced by events (evt.organization.deleted)'. There are exactly four consume() call sites (audit:49, billing:67, identity:211, projects:33 - the last never fires because every project operation is transport 'rpc') and none filters on an organization subject. The subject named in the comment does not exist either: derive.ts:309-314 produces evt.organization.delete, not .deleted. An owner deletes their org - identity.service.ts:194-203 transactionally removes invitations, members and the org row - and every project row for that org_id stays in Postgres forever, unreachable and unowned. The deletion promise a DPA makes is not kept and the table only grows.

Fixservices/projects/src/index.ts: add a consume({ stream: 'EVT', durable: 'projects-organization-delete', filterSubject: eventSubject('organization','delete'), handler: defineConsumer({ secret }, async ({ meta }) => projectService.deleteByOrganization(meta.orgId)) }), add the delete to services/projects/src/project.service.ts, and correct the subject in the schema.ts:8 comment. The projects nkey in infra/nats/generate-auth.ts currently has NO JetStream permissions at all - it needs $JS.ACK.>, $JS.API.INFO, $JS.API.CONSUMER.CREATE.EVT(.>), $JS.API.CONSUMER.INFO.EVT.*, $JS.API.CONSUMER.MSG.NEXT.EVT.* and $JS.API.STREAM.INFO.EVT added, or the consumer will fail at boot.

NoteConfirmed, including the .deleted/.delete subject mismatch. Severity lowered from high to medium: org ids are non-reusable random ids and every project query is scoped by organizationId, so orphans are unreachable garbage rather than a cross-tenant leak. The auth.conf gap in the fix is mine - the projects user has zero $JS permissions today, which the original fix did not mention.

medium
No test runner, no test script, tests/ outside the workspace
Tests
tests/registry-derive.test.ts:4
WhenVerified: package.json has no test script and verify (line 14) is typecheck + biome check + guardrail. pnpm-workspace.yaml lists apps/*, packages/*, services/*, tools, scripts - not tests - and every other workspace member has its own typecheck script, so nothing compiles this file. tools/guardrail-check.ts:37 SCANNED also omits it. The eight assertions run only when a human types pnpm tsx tests/registry-derive.test.ts. There is zero coverage of the trust boundary: no test that a flipped signature, an rpc envelope replayed onto the CMD subject (service.ts:247), an expired deadline (service.ts:256) or a meta with the permission stripped (service.ts:197) is refused.

FixAdd "test": "tsx tests/*.test.ts" to package.json and chain it into verify (line 14). Add "tests" to pnpm-workspace.yaml with a minimal package.json exposing typecheck, a tests/tsconfig.json extending tsconfig.base.json, and "tests" to SCANNED at tools/guardrail-check.ts:37. Then add tests/service-envelope.test.ts driving defineService(...).handle() with a valid envelope, a flipped signature byte, the right envelope on the wrong subject, a past deadlineAt and a stripped meta.permissions, asserting the reply code for each.

NoteEvery claim verified, including that tests/ is in no tsconfig include and no workspace glob.

medium
require-server-only is a raw substring search with a filename trigger
Enforcement
tools/guardrail-check.ts:194
WhenVerified: line 193 is source.includes('import "server-only"'), which a commented-out import satisfies - the Grit plugin (tools/grit/require-server-only.grit) matches the AST so it still fires, meaning this only bites when the plugin engine is off or the plugin is deleted per README:276. The bigger half is confirmed too: the trigger at lines 191-192 is a filename list (*.service.ts, *.adapter.ts, *.handlers.ts, src/db.ts) mirrored in biome.json:45, so a server module named repository.ts, queries.ts, email.ts or notifier.ts is required to import server-only by nothing. I checked the current tree and found no live violation among files that touch @guardrail/db/@guardrail/env/@guardrail/transport - the gap is latent, not already exploited.

Fixtools/guardrail-check.ts: replace the substring test at line 193 with an AST check for an ImportDeclaration whose specifier is "server-only" (the tree is parsed on the next line of the run loop), and invert the trigger - require server-only in any file importing @guardrail/db, @guardrail/env, @guardrail/transport or node:crypto, excluding the packages biome.json:105-122 declares client-safe.

NoteConfirmed, with the correction that there is no current violation - severity is for the next server file that is not named *.service.ts.

medium
apps/web can import @guardrail/service-*: the cross-service boundary only covers files inside services/
Enforcement
tools/guardrail-check.ts:220
WhenVerified: noCrossServiceImport returns at line 221 when the importing file has no services/ segment, and biome.json:168-242 scopes the @guardrail/service-* restrictions to services/audit, billing, identity, projects only. So nothing in the checker or in Biome stops apps/web importing a service. Two corrections to feasibility: apps/web/package.json lists no @guardrail/service-* dependency and services/projects/package.json declares no exports/main field, so the package-alias form needs two visible edits first; the form that works today with no manifest change is a relative import (../../../../services/projects/src/project.handlers), which the rule also ignores. The consequence stands: the handler pulls in services/projects/src/db.ts, giving the gateway a Postgres client (transitively, so biome.json:133 does not see it) and running with a hand-built ServiceContext instead of a verified envelope.

Fixtools/guardrail-check.ts: in noCrossServiceImport, when own === undefined, still report any specifier matching SERVICE_PACKAGE or resolving into services/. Add an apps/web override in biome.json listing @guardrail/service-projects, -identity, -billing and -audit as restricted paths.

NoteChecker gap confirmed. Downgraded high -> medium: no such import exists today, the package-name route needs a manifest edit that shows up in review, and only the relative-path route is silently available.

medium
The org-id-in-input scanner is blind to .merge(), spread shapes, z.object(CONST) and computed keys
Enforcement
tools/guardrail-check.ts:338
WhenAll four shapes verified against the code. (1) z.object({...}).merge(tenantScope): rootedInZObject walks the call/property spine to z.object and returns true, and scanForOrgId only walks the pushed expression subtree, so fields living in the imported tenantScope are never seen. (2) z.object({ ...sharedShape, name }): a SpreadAssignment is neither isPropertyAssignment nor isShorthandPropertyAssignment (line 344), so it is skipped silently. (3) z.object(SHAPE) with const SHAPE = { organizationId: z.string() } top-level in the same file: rootedInZObject returns true at line 379 and values is only consulted when the input expression is itself an identifier (line 383), so the declaration is never scanned. (4) { [ORG_KEY]: z.string() }: propertyName returns undefined for a ComputedPropertyName (line 131-137), so isOrgIdName never runs. ORG_ID_ALIAS (line 323) also misses organizationSlug/orgSlug/workspaceId/accountId, and a slug selects a tenant as well as an id does.

Fixtools/guardrail-check.ts: (a) in scanForOrgId report any SpreadAssignment or ComputedPropertyName inside an input subtree as un-analysable; (b) in rootedInZObject return false for .merge(x)/.and(x) and for z.object(identifier) unless the argument resolves to a top-level object literal in the same file, pushing that literal onto scan when it does; (c) widen ORG_ID_ALIAS to /^(?:org|organization|organisation|tenant|workspace|account|company)(?:id|slug)$/.

NoteAll four bypasses reproduced against the real code. Downgraded high -> medium: an org id in an input is not itself a leak until a handler reads it instead of ctx.orgId (every current handler uses ctx.orgId), so this is the loss of a defence-in-depth rule rather than a live cross-tenant path.

medium
noUnverifiedConsumer matches only the bare identifiers consume/serveRpc
Enforcement
tools/guardrail-check.ts:536
WhenVerified: isBusSubscription requires node.expression to be an Identifier in BUS_SUBSCRIBERS, so import * as bus from "@guardrail/transport"; bus.consume({...}) (PropertyAccessExpression) and import { consume as subscribe } both evade it. Worse and also verified: packages/transport/src/index.ts:8 re-exports ./connection, so connection() gives any file the raw NATS client and nc.subscribe(...) is invisible to the rule entirely. reachesVerifier (line 494-533) recurses over the whole subtree, so a handler that reads meta.orgId first and calls defineConsumer afterwards also passes. Either way a consumer takes meta.orgId off the wire: a forged evt.* meters a victim org and, because audit_log.requestId is unique with onConflictDoNothing (documented at service.ts:315-319), suppresses the genuine audit row.

Fixtools/guardrail-check.ts: resolve the callee through importedBindings so any call whose callee is a binding imported from @guardrail/transport as consume/serveRpc counts (covers aliases), and flag <ns>.consume(...) where <ns> is a namespace import of @guardrail/transport. Require in reachesVerifier that the verifier call be the handler's outermost expression. Add a biome.json noRestrictedImports entry (or a guardrail rule) forbidding connection from @guardrail/transport outside packages/transport and scripts/.

NoteConfirmed, and the raw-connection hole is worse than the alias hole. Note the consumer.consume() exclusion is deliberate per the comment at line 535, so the fix must resolve bindings rather than match on property names.

Low — hardening, polish, and invariants nothing currently asserts · 51
low
The local Upstash-compatible endpoint shipped in compose is documented nowhere, so the replay/idempotency path is never exercised locally
Repo
.env.example:26
Wheninfra/docker-compose.yml:59-66 runs hiett/serverless-redis-http on 127.0.0.1:8079 with SRH_TOKEN: dev-token specifically to back apps/web/src/gateway/replay.ts and the rate limiter, but .env.example:26-27 leaves UPSTASH_REDIS_REST_URL/TOKEN empty with no comment naming that endpoint. A developer therefore always runs the in-memory stores, and the Upstash code paths (UpstashStore.incr, UpstashReplayStore.claim/recall/remember - including the 'OK' vs nil semantics at replay.ts:95) are first exercised in production, where they are mandatory.

FixIn .env.example, set the two Upstash variables to the local values the compose file already provides (http://localhost:8079 and dev-token) with a comment that production replaces them with real Upstash credentials, and mention the redis-http container in the README quick start.

low
The sign-in page is not a form: no submit semantics, no in-flight lock, no sign-up or reset links
Web app
apps/web/src/app/(auth)/sign-in/page.tsx:14
WhenTwo Inputs and a Button with onClick (page.tsx:23-31) — no <form onSubmit>, so Enter does nothing for a user who types email, Tab, password, Enter; no autoComplete="username"/"current-password" for password managers; the button is never disabled while the request is in flight, so an impatient double-click burns two of the three attempts in the vendor's 10-second /sign-in window (rate-limiter/index.mjs:302-307). The raw provider error string is rendered (page.tsx:17). There is no registration page anywhere in apps/web even though /sign-up/email is open, and no reset link.

FixRewrite apps/web/src/app/(auth)/sign-in/page.tsx as a <form onSubmit>, add autoComplete attributes, gate the button on a pending flag, map provider error codes to product copy (special-case 429 with a retry hint), and link to the sign-up and forgot-password pages the other findings add.

NoteConfirmed with one correction to the original: sign-in DOES navigate on success — signIn.email passes callbackURL, sign-in.mjs:362-368 returns redirect:true with url, and the client's default redirectPlugin (better-auth/dist/client/fetch-plugins.mjs:3-17) performs the navigation. Only the form/UX claims stand.

low
Audit page renders raw ISO timestamps, has no empty state, and labels a role as "Actor"
Web app
apps/web/src/app/(dashboard)/audit/page.tsx:33
WhenVerified: line 33 prints entry.createdAt.toISOString() (UTC, millisecond precision) in the When column; there is no items.length === 0 branch, unlike project-list.tsx:83 and member-list.tsx:141, so a new Pro org sees three headers and nothing else and cannot tell an empty log from a broken one; line 31 renders entry.actorRole under a header reading "Actor" although the contract also carries actorId (audit.contract.ts:22).

FixIn apps/web/src/app/(dashboard)/audit/page.tsx wrap the value in <time dateTime={entry.createdAt.toISOString()}> formatted with Intl.DateTimeFormat inside a small client component so the machine value survives; add an empty row matching the copy pattern at project-list.tsx:83; rename the header to "Actor role" or render entry.actorId.

NoteDowngraded to low — all three are presentation issues. Note the page cannot reach line 33 today: createdAt is z.date() over a JSON transport, so the gateway's output parse throws first (see missed finding 1). Fix that before this is observable.

low
The ?locked=<resource> the layout redirects with is never read by anything
Web app
apps/web/src/app/(dashboard)/billing/page.tsx:7
Whenapps/web/src/app/(dashboard)/layout.tsx:34 redirects a plan-locked user to /billing?locked=${resource}, but BillingPage takes no searchParams argument and a repo-wide grep for locked across apps/web/src/app and apps/web/src/features finds only that one redirect line. A pro-plan admin clicking a scale-only nav item is silently teleported to Billing with no explanation of what was refused or which plan restores it — the registry even has the copy ready (RESOURCES[resource].upgrade(nextPlan) in packages/registry/src/registry.ts).

FixGive apps/web/src/app/(dashboard)/billing/page.tsx a searchParams prop, validate the value with a ResourceKey guard from @guardrail/registry, and render the registry's own upgrade message above the PricingTable when present.

low
Identity is resolved twice per dashboard render, doubling session+member queries against a 10-connection pool
Web app
apps/web/src/app/(dashboard)/layout.tsx:22
WhenThe dashboard layout calls identify() at layout.tsx:22 and gatewayDeps.entitlements() at :26, and then each page's server-side api.* call runs dispatch, which calls deps.identify again (packages/guardrail/src/gateway.ts:124) and deps.entitlements again (:180). identify is not wrapped in React cache() (unlike createContext in apps/web/src/trpc/server.ts:14), so a single /team render performs the Better Auth session lookup plus the member SELECT at least twice against a pool created with max: 10 (packages/db line 24). Under a burst of dashboard navigations this doubles the pool pressure for no new information.

FixWrap identify's per-request result in React cache() at the call site — export a cachedIdentify from apps/web/src/gateway/deps.ts using cache() from react and use it both in gatewayDeps.identify and in apps/web/src/app/(dashboard)/layout.tsx, so one render resolves identity once. The entitlements Map cache already dedupes the second concern for 30s.

low
/onboarding has no server-side auth check — the only guard is a cookie presence test
Web app
apps/web/src/app/onboarding/page.tsx:23
WhenThe page sits outside the (dashboard) group, so the route guard at apps/web/src/app/(dashboard)/layout.tsx:22 — 'the guard for the gap the gateway cannot cover' — never runs for it; only apps/web/src/app/layout.tsx wraps it. The sole check is proxy.ts:31, which tests that a cookie *named* better-auth.session_token exists, not that it verifies. Setting document.cookie='better-auth.session_token=x' and visiting /onboarding renders the page to an anonymous visitor. No data leaks — the page is a client component with no server data and the mutation dies at gateway.ts:125 — but every future page added outside (dashboard) inherits zero authentication, which is precisely what the layout guard exists to prevent.

FixEither move onboarding into (dashboard) with a variant layout that tolerates a missing active org (this pairs with the no-org identity fix), or make apps/web/src/app/onboarding/page.tsx a server component that calls identify(await headers()) and redirects when null. Add a rule in tools/guardrail-check.ts asserting every non-public page directory is covered by a layout that calls identify().

NoteConfirmed, severity corrected medium -> low: nothing sensitive renders and no mutation succeeds. The value here is the structural check in guardrail-check.ts, not the page.

low
Sidebar gives no active-page indication and the nav has no accessible name
Web app
apps/web/src/components/sidebar.tsx:8
WhenVerified: sidebar.tsx:12-18 renders every item as an identical Link with identical classes, no aria-current and no active styling; the <nav> at line 8 has no aria-label. A user on /team sees nothing distinguishing Team from Projects, and a screen-reader user hears "Projects link, Team link, Billing link" with no sense of location. The layout already has the answer — x-pathname at layout.tsx:29 and resourceForPath at line 30 — and passes only items and plan at line 40.

FixPass the resolved resource (or pathname) from apps/web/src/app/(dashboard)/layout.tsx:40 into Sidebar; in apps/web/src/components/sidebar.tsx set aria-current={isActive ? "page" : undefined} plus an active class, and aria-label="Primary" on the <nav>. Keeps it a server component — no usePathname needed.

NoteDowngraded from medium to low: real but cosmetic (location indication is WCAG 2.4.8, AAA). The data-plumbing observation is accurate and makes the fix cheap.

low
PriceGate used without FeatureGate on the team page
Web app
apps/web/src/features/team/member-list.tsx:77
WhenVerified: member-list.tsx:76-77 composes AccessGate + PriceGate with no FeatureGate (grep confirms FeatureGate is never imported anywhere in apps/web), and price-gate.tsx:41 matches only reason === "limit_reached", falling through to children at line 46 for not_in_plan. If member.limits ever gains a false for a plan — the registry's own supported value, already used by organization (registry.ts:110) and auditLog (registry.ts:318) — the invite form renders for that plan and the gateway refuses at gateway.ts:180-186.

Fixapps/web/src/features/team/member-list.tsx:76: <AccessGate resource="member" operation="create"><FeatureGate resource="member"><PriceGate resource="member">, or collapse the nest to <Gate resource="member" operation="create"> once gate.tsx's fallback default is fixed. A GritQL rule under tools/ flagging a bare FeatureGate/PriceGate outside its partner would make it structural.

NoteDowngraded from medium to low: the composition gap is real, but member.limits today is {free:2, pro:10, scale:"unlimited"} (registry.ts:239), so no plan can produce not_in_plan for member. The failure requires a future registry edit — latent drift, not a live bug.

low
The entitlements cache is an unbounded Map that never evicts expired entries
Gateway
apps/web/src/gateway/deps.ts:23 · reported by 2 auditors (plan-gating-billing, ops-observability-config)
AlsoNothing evicts the gateway's in-process entitlements cache and its invalidation function has no caller

Whenapps/web/src/gateway/deps.ts:23 declares a module-level Map; entries are added on every cache miss (line 42) and only ever overwritten, and cache.delete is reachable only through the never-called invalidateEntitlements (line 25-27). A long-lived gateway instance serving 200k organisations retains 200k {plan, usage} objects plus keys indefinitely, most long expired, because the expiry check at line 31 filters reads without removing anything.

Fixapps/web/src/gateway/deps.ts — sweep on write (when the map exceeds N, drop entries whose expiresAt is past) or replace the Map with a small LRU. This is also where the lastKnownGood map from the fail-open finding belongs, so do both in one change.

NoteConfirmed. Low is right — the objects are tiny (a plan string and a handful of numbers), so this is tens of MB at 200k orgs, a slow leak rather than the fast OOM loop the original implied. Also note the Map is per-process, so on serverless it is bounded by instance lifetime anyway.

low
requestIdOf turns a proxy-matcher miss into a 500 that leaks internal guidance and fails the whole batch
Gateway
apps/web/src/gateway/init.ts:26
WhenConfirmed: createContext throws INTERNAL_SERVER_ERROR with the message naming proxy.ts and its matcher, and tRPC's default shape puts error.message on the wire. Because it throws in context creation it fails every procedure in an httpBatchLink batch. It also fires on the RSC path (apps/web/src/trpc/server.ts builds the same context from next/headers), so a matcher regression blanket-500s every dashboard page, not just API calls.

FixIn apps/web/src/gateway/init.ts keep the invariant but split the audience: throw a TRPCError with a generic message and console.error the diagnostic detail (path, that proxy.ts did not cover it) server-side. Do not silently mint a fallback id — the audit trail is keyed on the proxy-minted id and a second source would give one request two ids, which the file header at lines 6-9 explicitly forbids.

NoteConfirmed, severity correctly low. The auditor's preferred fix (mint crypto.randomUUID() in init.ts and continue) directly contradicts the documented invariant in this file's own header — I inverted the fix to the alternative the auditor listed second.

low
ip is parsed from a spoofable X-Forwarded-For, threaded through dispatch, and never used
Gateway
apps/web/src/gateway/init.ts:39
WhenConfirmed: init.ts:39 takes the first XFF entry with no trusted-hop count; it is on GatewayContext (init.ts:20), spread into dispatch via procedures.ts:53/66, declared on DispatchArgs (gateway.ts:103) — and dispatch destructures only { deps, resource, operation } at gateway.ts:118, so args.ip is never read. RequestMeta (gateway.ts:190-201) has no ip field, so no audit row records the source address of a destructive action.

FixEither delete ip from GatewayContext (apps/web/src/gateway/init.ts) and DispatchArgs (packages/guardrail/src/gateway.ts:103), or make it trustworthy before anything consumes it: read it from your ingress's own header in init.ts and add it to RequestMeta in packages/contracts so it is signed into the envelope and lands in the audit row.

NoteConfirmed dead today; the value of the finding is that it is a loaded gun for whoever next wires ip into the rate-limit key. Low is correct.

low
error.trpcCode as "FORBIDDEN" defeats the only compile-time check on ERROR_HTTP_MAP
Gateway
apps/web/src/gateway/procedures.ts:22 · reported by 2 auditors (gateway-http-web, enforcement-types-tooling)
Alsoerror.trpcCode as "FORBIDDEN" launders an unchecked string into a tRPC error code

WhenVerified: GatewayError.trpcCode (packages/guardrail/src/gateway.ts:86-88) returns ERROR_HTTP_MAP[code], typed Readonly<Record<ErrorCode, string>> at packages/contracts/src/errors.ts:50 - plain string, unrelated to tRPC's code union - and the assertion at procedures.ts:22 is all that makes it compile. Correction: all twelve values currently in the table (UNAUTHORIZED, FORBIDDEN, TOO_MANY_REQUESTS, NOT_FOUND, CONFLICT, BAD_REQUEST, INTERNAL_SERVER_ERROR, TIMEOUT) are valid TRPC_ERROR_CODE_KEYs, so there is no live defect - the assertion is erased and the runtime value is correct today. The failure needs a future edit to errors.ts introducing a typo or a non-tRPC key, which no compiler would catch; tRPC then cannot map it, the response degrades to a 500 and init.ts:52's app branch never carries the structured denial to the upgrade prompt.

Fixapps/web/src/gateway/procedures.ts: declare const TRPC_CODE: Record<ErrorCode, TRPCError["code"]> (importing ErrorCode from @guardrail/contracts), look the code up there and delete the as. Leave ERROR_HTTP_MAP as the HTTP-facing table so packages/contracts stays free of a @trpc dependency.

NoteType hole confirmed, but downgraded medium -> low: the auditor's premise that the assertion 'asserts a value that is usually not FORBIDDEN' is irrelevant at runtime, and no current mapping is invalid, so this is a latent regression risk, not a live bug.

low
In-memory limiter, entitlements and replay Maps are never pruned
Gateway
apps/web/src/gateway/ratelimit.ts:28
WhenConfirmed. ratelimit.ts:28 buckets is only ever written (lines 37, 39) - an expired bucket is overwritten when the same key returns but never deleted otherwise - so a single-instance production deploy with RATE_LIMIT_ALLOW_IN_MEMORY=on accumulates one entry per (org, resource, operation) seen since boot. apps/web/src/gateway/deps.ts:23 has the same shape: entries carry expiresAt but are only removed by invalidateEntitlements at line 25, so a long-lived gateway retains one entry per org it has ever served. apps/web/src/gateway/replay.ts:41-42 (claims/replies) has the identical pattern, though it is dev-only because selectStore throws in production without Upstash. Entries are small, so this is a slow leak measured in tens of MB at 100k orgs, not a fast one.

FixIn apps/web/src/gateway/ratelimit.ts, apps/web/src/gateway/deps.ts and apps/web/src/gateway/replay.ts sweep expired entries on write and cap each Map with simple LRU eviction (better-auth's own memory store does exactly this with MEMORY_STORE_MAX_ENTRIES).

NoteSeverity reduced from medium to low: the growth is real and unbounded but the per-entry cost is tiny and the limiter Map only exists in production behind an explicitly opted-in single-instance flag. Added replay.ts, which the auditor missed and which has the same defect.

low
INCR and EXPIRE are not atomic, leaking untimed Redis keys
Gateway
apps/web/src/gateway/ratelimit.ts:66
WhenConfirmed in code, unverifiable in behaviour. ratelimit.ts:66-69 posts [['INCR', key], ['EXPIRE', key, windowSeconds]] to Upstash's /pipeline, which is documented as non-transactional, and line 74 reads only payload[0]?.result - an error on the EXPIRE leg is never inspected. If INCR lands and EXPIRE does not, the key rl:<org>:<resource>:<op>:<window> survives with no TTL, and because the window number is baked into the key it is never revisited, so it is permanent garbage: one key per org per operation per affected window, growing the Upstash keyspace and bill until someone looks.

FixIn apps/web/src/gateway/ratelimit.ts change the POST at line 61 to ${this.url}/multi-exec so both commands land atomically, or replace them with one EVAL doing INCR + EXPIRE. Also read payload[1] and log when the EXPIRE leg reports an error. Apply the same to apps/web/src/gateway/replay.ts, which posts single commands to /pipeline (line ~78) and is fine today but shares the pattern.

NoteSeverity reduced from medium to low. The code path is exactly as described, but whether Upstash's /pipeline can actually apply one command and not the other in a single HTTP request is a vendor behaviour I cannot verify from this repo - it requires a connection drop mid-execution or an EXPIRE-specific error. The unchecked payload[1] is a real, verifiable gap regardless.

low
Public-path checks use startsWith, so future /sign-in* and /api/auth* routes are silently exempt
HTTP edge
apps/web/src/proxy.ts:27
WhenConfirmed: proxy.ts:28-29 use startsWith('/sign-in') and startsWith('/api/auth'), which would also match /sign-in-preview, /api/authorize, /api/auth-debug. No such route exists today (apps/web/src/app contains only (auth)/sign-in and api/auth, api/trpc), so this is latent: the exemption is invisible at the point a future route is added.

FixIn apps/web/src/proxy.ts compare exact paths plus a trailing slash (p === '/sign-in' || p.startsWith('/sign-in/'), same for /api/auth), or export a PUBLIC_PATHS constant so a new public route is a declaration rather than a prefix coincidence.

NoteConfirmed as latent only — no currently existing route matches the loose prefix. Severity low is right.

low
Sign-in discards the requested destination
HTTP edge
apps/web/src/proxy.ts:34
WhenConfirmed: proxy.ts:34-36 clones the URL and overwrites pathname with /sign-in, and the sign-in page hard-codes callbackURL: '/projects' (apps/web/src/app/(auth)/sign-in/page.tsx:16). A signed-out user following a link to /team or /billing always lands on /projects.

FixIn apps/web/src/proxy.ts set url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search) before returning the redirect, and in apps/web/src/app/(auth)/sign-in/page.tsx read it with useSearchParams and pass it as callbackURL only after validating it starts with '/' and not '//' so it cannot become an open redirect.

NoteConfirmed. Minor addition: the clone also carries the original query string onto /sign-in today (e.g. /sign-in?locked=auditLog), which is harmless but shows the intent was already half there.

low
SSR-side tRPC client has no base-URL fallback and forwards no cookies
Web app
apps/web/src/trpc/react.tsx:31
WhenConfirmed: url is ${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/trpc on the server branch and there is no headers() option to forward the incoming cookie. Currently dormant because both client queries pass initialData (project-list.tsx:31, member-list.tsx:42). The first client query added without initialData will, during SSR, either throw 'Failed to parse URL from /api/trpc' when NEXT_PUBLIC_APP_URL is unset or issue a cookieless request that proxy.ts:33 answers with the HTML sign-in page.

FixIn apps/web/src/trpc/react.tsx add a headers() option to httpBatchLink that forwards the incoming cookie header on the server branch, and make the server base URL fail loud when NEXT_PUBLIC_APP_URL is missing — packages/env already exposes appUrl (line 69) via requireValue, so use that rather than the ?? '' fallback.

NoteConfirmed as latent. Note the same env var is also read raw at apps/web/src/app/layout.tsx:16 for AutumnProvider betterAuthUrl, so routing both through packages/env's appUrl() fixes two sites at once.

low
no-process-env is scoped to **/*.ts so .tsx files are unchecked
Enforcement
biome.json:41
WhenVerified: the plugin includes at biome.json:41 are ["**/*.ts", ...] with no .tsx, and apps/web/src/trpc/react.tsx:31 and apps/web/src/app/layout.tsx:16 both read process.env.NEXT_PUBLIC_APP_URL unchecked. tools/guardrail-check.ts has no backstop for this rule, so README:276's advice to delete a misfiring plugin because the checker 'already covers the same three rules' is wrong for this one. Two mitigations the auditor missed, which is why this is low: noPropertyAccessFromIndexSignature makes process.env.ANYTHING a type error unless declared (apps/web/src/env.d.ts declares only NEXT_PUBLIC_APP_URL), and Biome's recommended complexity/useLiteralKeys - disabled only for packages/env/src/index.ts at biome.json:288 - rejects the process.env["SECRET"] workaround. So a .tsx file cannot in practice read an undeclared secret today.

Fixbiome.json:41: change includes to ["**/*.ts", "**/*.tsx", "!**/packages/env/**", "!**/drizzle.config.ts"] and exempt the NEXT_PUBLIC_ dot-access form (or the two files) rather than routing them through @guardrail/env. Do NOT apply the auditor's fix as written: packages/env/src/index.ts:30-42 documents that Next only substitutes the literal key, so env.publicAppUrl()'s bracket read yields undefined in the browser - react.tsx:31 is a "use client" module and must keep dot access. Add a noProcessEnv AST rule to tools/guardrail-check.ts so README:276 becomes true.

NoteCoverage gap confirmed; severity downgraded medium -> low because two other strict-mode mechanisms already block the dangerous case, and the proposed remediation for the two live sites would break the client bundle.

low
One Postgres role for every service and no RLS — the tenant boundary is application WHERE clauses only
Infra
infra/docker-compose.yml:26
WhenThe code half is confirmed: packages/env exposes a single databaseUrl() and createDb defaults to it (packages/db/src/index.ts:31), so authDb and all three service dbs share one connection string and therefore one role; there are no GRANTs and no RLS policies anywhere in the repo. Every tenant scope is a hand-written eq(table.organizationId, ...) in a *.service.ts. A single omitted predicate in a future query returns other tenants' rows with nothing underneath to refuse it.

FixCreate per-service roles with table-level GRANTs in a committed SQL migration, and set a distinct DATABASE_URL per service in deployment (packages/env would need per-service resolution). For defence in depth, enable RLS on project and audit_log with a policy on current_setting('app.org_id') and set that GUC per transaction from the envelope's orgId in services/*/src/db.ts.

NoteDowngraded medium -> low, and the cited file is only partly right: infra/docker-compose.yml is explicitly the local dev stack (the header comment says so) and contains no service containers at all, so it is not evidence about production. There are no production deployment manifests in the repo to check. This is a real defence-in-depth gap but not a defect — every query I read is correctly scoped today.

low
make up races the stack with a fixed sleep 3 even though every container declares a healthcheck
Repo
Makefile:10
Whenpnpm infra:up && sleep 3 && pnpm nats:bootstrap. infra/docker-compose.yml declares healthchecks for nats (line 20), postgres (36) and redis (53) at 5s intervals with 10 retries and nothing waits on them. On a cold machine pulling the NATS image or replaying a JetStream store, 3s is short: nats:bootstrap fails, scripts/bootstrap-streams.ts exits 1, and make up stops - so the developer starts services against a NATS with no CMD/EVT streams, which then surfaces as the swallowed consumer error above rather than as the missing-stream problem it is.

FixChange infra:up in package.json (or the Makefile target) to docker compose -f infra/docker-compose.yml up -d --wait and drop the sleep, so compose blocks on the healthchecks that are already declared.

NoteVerified. Note that redis-http declares no healthcheck of its own, so --wait will treat it as ready as soon as it starts.

low
make reset names volumes that do not exist, so 'wipe local data' silently keeps the old data
Repo
Makefile:43
Whenpnpm infra:down && docker volume rm guardrail_nats-data guardrail_pg-data || true. Compose derives the project name from the directory holding the compose file, which is infra/, so the real volumes are infra_nats-data, infra_pg-data and infra_redis-data (declared at docker-compose.yml:71-74). docker volume rm fails with 'no such volume', || true hides it, and the developer who ran make reset to clear a corrupt JetStream store or a bad migration restarts on exactly the same data. redis-data is not listed at all.

FixReplace line 43 with docker compose -f infra/docker-compose.yml down -v, which removes the project's own volumes regardless of the derived project name, and drop the hand-written names and the || true.

NoteVerified against the compose file's volume declarations. Severity lowered medium -> low: local-developer time only, no production surface.

low
activeOrganizationId is chosen only at session creation, and there is no set-active UI — deleting or leaving an org strands the session
Auth
packages/auth/src/auth.ts:111
WhenPartly confirmed, materially overstated. The session before hook (auth.ts:111-117) picks the active org once at sign-in. After organization.remove or membership.delete the cookie still names the dead org, identify() (identity.ts:28-38) finds no member row and returns null, and (dashboard)/layout.tsx:24 redirects to /sign-in. But the claimed lockout does not occur: /sign-in is in proxy.ts's public list (:26-29) and (auth)/sign-in/page.tsx has no already-signed-in guard, so the page renders and signing in again runs the hook and picks the user's oldest remaining membership. The real residue is smaller: an unexplained bounce to a sign-in screen, and — because organization.setActive is called from exactly one place in the app (onboarding/page.tsx:31) and there is no org switcher — a multi-org user is otherwise pinned to their oldest membership for the life of every session.

FixIn packages/auth/src/identity.ts, when session.activeOrganizationId resolves to no member row, fall back to the user's oldest remaining membership using the same ordered query as auth.ts:112-115 and persist it via auth.api.setActiveOrganization before returning. That fixes the bounce and the pinning in one place. An org switcher in apps/web calling organization.setActive (KEPT for exactly this reason, superseded.ts:68) is the product-side half.

NoteDowngraded medium → low. The "locks the user out for the life of the session" and "only recovery is signing out and back in" claims are refuted — re-signing in is precisely what the redirect lands the user on, and it works. What is left is a UX dead-end plus the absent org switcher. Nothing here is an authorisation hole: identify() verifies the member row rather than trusting the session claim, so a forged activeOrganizationId still yields null.

low
No social or enterprise SSO; the account table's OAuth columns are unused
Auth
packages/auth/src/auth.ts:121
WhenThe plugin list is organization + autumn + nextCookies (auth.ts:121-135): no socialProviders, no SSO/OIDC/SAML plugin, no magic link, no passkey. packages/auth/src/schema.ts:35-51 carries accessToken/refreshToken/idToken/scope columns nothing will write. For a B2B SaaS boilerplate this makes the password path the entire authentication story, so every weakness in it is unmitigated.

Fixpackages/auth/src/auth.ts — add socialProviders: { google, github } with keys read through packages/env/src/index.ts (never process.env directly), and register better-auth's sso plugin keyed on the organisation. Because packages/auth/src/identity.ts keeps returning the same normalised GatewayIdentity, no service, router or component changes.

NoteFactually confirmed but it is a roadmap gap, not a defect — nothing behaves wrongly today. One correction: the account table is not dead; better-auth stores the credential password hash in account.password (schema.ts:47), which is what sign-in.mjs:319 reads.

low
setUsage claims to set an absolute count but increments — a loaded gun for the next caller
Billing
packages/billing/src/autumn.adapter.ts:95
Whenpackages/billing/src/autumn.adapter.ts:94 documents "Set an absolute count for non-consumable features such as seats" and lines 103-107 call the identical autumn.track({customer_id, feature_id, value}) that track uses at lines 84-88, which adds to the feature balance. It is referenced nowhere in the repo (grep across apps, packages, services, tests, tools, scripts), so the first person to wire it up for seats — the obvious fix for the seat-drift and delete-never-decrements findings above — will call setUsage({usage: 7}) on an org that already reads 7 and produce 14, instantly locking a 10-seat Pro org out of inviting.

Fixpackages/billing/src/autumn.adapter.ts:94-111 — implement it against Autumn's balance API, which does set rather than add: the SDK exposes autumn.customers.updateBalances(id, params) (autumn-js dist/sdk/index.js:184, POST /customers/:id/balances, typed as UpdateBalancesParams). Or delete the function until there is a caller. Do not leave an increment behind a name that says set.

NoteConfirmed, and the exact replacement API is verified to exist in the pinned SDK. Severity downgraded medium -> low: today it is unreferenced dead code with zero runtime effect. It becomes blocking the moment findings 10 or 13 are fixed, so fix it first in that sequence.

low
Reply MAC has no domain tag and does not name the answering service
Wire
packages/contracts/src/envelope.ts:258
WhencanonicalEnvelope carries an explicit domain: "request" | "event" (line 206-207) because same-secret MACs over overlapping fields are otherwise interchangeable, but canonicalReply has no such tag. The two do not collide today only because their key sets happen to be disjoint, and the satisfies Record<keyof ReplyBinding | "dataHash"> pattern at line 265 actively invites adding fields to ReplyBinding - at which point a reply MAC and a request MAC under the same secret could be made to agree. The binding also never names the responder, so any service's key produces a reply the gateway accepts for any resource.

Fixpackages/contracts/src/envelope.ts: add domain: "reply" as the first field of the canonical object in canonicalReply and extend ReplyBinding with service: ServiceName; have defineService pass its own service into every signReply call (packages/guardrail/src/service.ts:183 and 291) and have gateway.ts:251 and request.ts:60 verify with RESOURCES[resource].owner.

NoteConfirmed as written but severity medium -> low: I compared the two canonical key sets and they are disjoint (request: domain/requestId/orgId/userId/role/permissions/plan/resource/operation/issuedAt/deadlineAt/traceparent/payloadHash; reply: requestId/resource/operation/ok/dataHash), so no collision exists today and the finding is hardening against a future field addition. The 'names the responder' half is the shared-secret finding in another shape.

low
traceparent is declared in the envelope but never set and never propagated
Wire
packages/contracts/src/envelope.ts:54
Whentraceparent: z.string().optional() is in requestMeta and is included in the signed canonical form at envelope.ts:248, but a repo-wide grep finds only those two occurrences: packages/guardrail/src/gateway.ts:190-201 builds RequestMeta without it, apps/web/src/gateway/internal-envelope.ts does not set it, and no service reads it. When a request is slow there is an envelope field designed to correlate gateway -> bus -> service and nothing to put in it; the only identifier that actually travels is requestId, which the gateway never logs (see the logging finding).

FixEither populate it - generate a W3C traceparent in apps/web/src/proxy.ts beside the request id, set it on meta in packages/guardrail/src/gateway.ts:190 and in internal-envelope.ts, and log it in packages/guardrail/src/service.ts - or delete the field from packages/contracts/src/envelope.ts so the wire format stops advertising a capability that does not exist.

NoteLine 54 correct; the serialisation line is 248, not 223. Severity lowered medium -> low: an unused optional field is a documentation defect, and the real observability gap is the missing logging finding.

low
The production-only safety throws are keyed on NODE_ENV, which nothing in the service start path sets
Config
packages/env/src/index.ts:78
WhenisProduction() (line 78) and the NATS-seed throw (line 61) both test process.env["NODE_ENV"] === "production". next start sets it for the gateway, but the four services boot via tsx --conditions=react-server src/index.ts (services/*/package.json:8), which sets nothing, and NODE_ENV is absent from .env.example. So a deployment of services/billing with no NATS_NKEY_SEED does not get the documented boot error; it connects with no authenticator and fails later with an opaque server-side nkey error.

FixDeclare NODE_ENV (or better, an explicit APP_ENV read through required()) in packages/env/src/index.ts and add it to .env.example and the per-service deployment env contract, so a service cannot boot without stating its environment.

NoteSeverity lowered medium -> low: the practical consequence is only a worse error message. auth.conf declares no anonymous user, so a seedless service is refused by the server, connect() rejects, main().catch fires and the process exits 1 either way - it just does so with 'Authorization Violation' instead of the intended message.

low
refusedRole only inspects a top-level string role — any other grant shape would pass both halves of the escalation gate
The block
packages/guardrail/src/escalation.ts:22
WhenConfirmed as written, but it is a latent fragility, not a live hole. namedRole (escalation.ts:22-27) returns null unless the input is a non-null object with an own string-valued role. The only role-carrying inputs that exist today are member.create {email, role} and member.update {memberId, role} (identity.contract.ts:36, :44), both covered, so there is no current bypass. The moment somebody adds a bulk invite ({invites:[{email,role}]}), a nested {member:{role}} or a plural {roles:[...]}, refusedRole returns null, gateway 4b and service 5b both pass, and the only remaining barrier is the operation's minRole. Non-string values also return null, though the contract enum refuses them a step later. The "no test" claim holds: tests/ contains only registry-derive.test.ts.

FixMake refusedRole in packages/guardrail/src/escalation.ts walk the input recursively with a bounded depth, arrays included, refusing the first value under any key matching /^roles?$/ that is not in assignableRoles(actor), and refusing non-string values outright so an unrecognised shape fails closed. Add tests/escalation.test.ts covering nested, array and plural shapes alongside the existing registry-derive test.

NoteDowngraded medium → low: no reachable escalation exists today because both role-bearing contracts are flat. Worth doing because the file is the platform's only escalation gate and has no test.

low
traceparent is declared and signed but never populated
The block
packages/guardrail/src/gateway.ts:200
WhenrequestMeta.traceparent (envelope.ts:53-54) promises 'one trace spans gateway, bus and service' and sits inside the signed canonical form (envelope.ts:223). Grep across apps, packages and services returns exactly three hits, all three inside envelope.ts - there is no assignment anywhere. The meta literal at gateway.ts:190-201 omits it, so canonicalEnvelope always signs null and every cross-service investigation falls back to grepping requestId across five processes' stdout. The schema is also a bare z.string().optional() with no format check, so whoever wires it later can put an attacker-influenced string into a field that reaches trace backends and log lines.

FixSet traceparent in the meta literal in packages/guardrail/src/gateway.ts:190-201 from the active OTel span, or mint 00-<32 hex>-<16 hex>-01 from the requestId when no tracer is installed, and tighten packages/contracts/src/envelope.ts:54 to z.string().regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/).optional() so an unparseable value is a refused envelope rather than a poisoned log line.

NoteBoth halves confirmed by grep and by reading the meta literal. Low is right - it is an observability gap plus an unvalidated signed field, not a live vulnerability.

low
The pre-signed 'unreadable' refusal is indistinguishable from a forged reply in logs
The block
packages/guardrail/src/service.ts:127
WhenUNROUTED carries requestId 'unknown' (service.ts:127-131) and unreadable is built from it (service.ts:217-221). serveRpc responds with it when decode() throws on non-JSON bytes (serve.ts:39, 44). At the caller, rpcRequest's request-id check fires before the signature check (request.ts:51-56) and throws UNTRUSTED_ENVELOPE, which gateway.ts:227-228 surfaces verbatim. A genuine 'the service could not parse your bytes' and an active 'somebody else answered for this service' therefore produce the same error code, on the one signal that should be loudest.

Fixpackages/transport/src/serve.ts: extract meta.requestId from the raw bytes when it is recoverable and pass it to a per-message refusal instead of the pre-signed constant; or add a distinct code in packages/transport/src/request.ts:51-56 for a reply whose requestId is the literal 'unknown' sentinel, so alerting can separate 'service refused to parse' from 'forged reply'.

NoteSubstance confirmed, with one correction to the original scenario: the surfaced message is 'The reply on <subject> answers a different request.' (request.ts:54), not 'is not signed by the owning service' - the requestId check at :51 fires before the MAC check at :59. Both throw the same UNTRUSTED_ENVELOPE code, which is the actual defect. Documented as deliberate at service.ts:120-126.

low
Service signs refusals bound to unverified, attacker-chosen meta
The block
packages/guardrail/src/service.ts:233
WhenWhen verifyRequest fails at line 232 the refusal is built as reject(meta, ...) using the meta from the message that just failed verification, and reject (line 183) calls signReply({...route, ok: false}, error, options.secret). So a publisher who reaches any rpc subject receives a valid reply MAC over any (requestId, resource, operation, false) triple it chooses, without knowing the secret. This contradicts the UNROUTED rationale at lines 120-131, which states that a pre-verification refusal must not name an operation, and the malformed-envelope branch two lines above (226) already does the right thing.

Fixpackages/guardrail/src/service.ts line 233: change the signature-failure branch - and only it, since branches at 242, 248, 258 and 305 run on verified meta - to return reject(UNROUTED, "UNTRUSTED_ENVELOPE", "Envelope signature is not valid.").

NoteThe oracle is real, but the exploit path in the finding is refuted twice, so medium -> low. (1) Request ids are server-minted crypto.randomUUID() and an inbound x-request-id is discarded (apps/web/src/proxy.ts:24 and the comment at 7-13), so ids read out of an audit row belong to completed requests and a live id is unguessable. (2) Delivering a forged refusal needs publish rights on _INBOX.gateway.>, which no user in infra/nats/auth.conf has - the gateway's own publish list is rpc/cmd subjects only (line 26), services get allow_responses for messages they actually received (37, 48, 59, 69), and observer is publish-deny (89). Worth fixing as the file's own stated invariant, not as a reachable attack.

low
The replay/idempotency store exists but has no caller
The block
packages/guardrail/src/service.ts:261
WhenThe wiring gap is confirmed and self-documented: apps/web/src/gateway/replay.ts:21-22 names "packages/guardrail/src/service.ts - the injected call site, step 2b", service.ts has no such step (verification at :232 goes straight to routing at :237 and reassertAuthority at :261), grep finds zero callers of claimReplay/recallReply/rememberReply outside their own definitions, and infra/nats/RUNBOOK.md:150-157 states plainly that the store has no caller as of 2026-08-18. The *attack* scenario is largely refuted, however. infra/nats/auth.conf is real, generated from the registry and loaded by nats.conf:33, and it is per-user: cmd.member.create is publishable only by the gateway nkey (auth.conf:26); the identity nkey may publish evt.* and $JS.* but no cmd.* or rpc.* (:46); audit may publish nothing but $JS.* (:67); the observer is deny-all on publish (:89). So "a compromised service or a stray script republishes a captured command" needs the gateway's own nkey, and reading the CMD stream to capture one needs identity's — two separate credentials, and whoever holds the gateway's key almost certainly holds ENVELOPE_SECRET and can mint fresh envelopes anyway.

FixStill worth wiring, primarily as an at-least-once idempotency guarantee rather than as a replay control: add replay?: { claim(key: string, ttlMs: number): Promise<"fresh"|"duplicate"|"unavailable"> } to defineService's options in packages/guardrail/src/service.ts and call it immediately after verifyRequest at :232, keyed ${service}:${meta.resource}.${meta.operation}:${meta.requestId}; refuse duplicates for rpc and recall the remembered reply for commands. The store in apps/web/src/gateway/replay.ts is app-scoped, so it has to move to a shared package before services can import it — that move is part of the fix, not a detail.

NoteDowngraded high → low. The gap is real and documented; the exploit path as written is blocked by infra/nats/auth.conf, which the original finding did not account for. Its remaining value is idempotency under redelivery, which today rests on one ad hoc check at identity/index.ts:61.

low
Nothing observes bus connection status, so a disconnected service looks identical to a healthy one
Bus
packages/transport/src/connection.ts:38
WhenGrep across packages/, apps/, services/ and scripts/ for nc.status(), .closed() or any reconnect handling returns zero hits. With maxReconnectAttempts:-1 (connection.ts:45), a service disconnected from NATS for an hour prints nothing, exposes no health endpoint (the services' package.json scripts are only dev/start), and looks alive to any supervisor. Combined with the silently-ending consumer loop, an audit outage can persist until somebody checks consumer pending by hand.

Fixpackages/transport/src/connection.ts: after connect resolves, spawn a detached for await (const s of nc.status()) loop that logs every disconnect/reconnect/error with the server and the gap duration, and export a busHealthy() predicate reading the last status. Add a minimal http.createServer health endpoint to each services/*/src/index.ts reporting bus status and whether each consumer loop is still running.

NoteConfirmed by grep. Low as an independent finding, but it is the reason the two higher-severity silent-failure findings stay undetected in production - worth fixing alongside them rather than on its own.

low
Gateway and transport read the envelope secret from two different sources
Bus
packages/transport/src/request.ts:70
Whendispatch signs and verifies with the injected deps.secret (gateway.ts:208 and 261, wired at apps/web/src/gateway/deps.ts:68), but rpcRequest verifies the reply with env.envelopeSecret() read straight from the module at request.ts:70. The GatewayDeps.secret seam therefore only half exists: a test harness, a staging override or the dual-key rotation proposed above that sets deps.secret to anything other than the process env makes every rpc fail at verifyReply with 'is not signed by the owning service' while the request itself was signed correctly - a failure that reads like a service compromise.

Fixpackages/transport/src/request.ts: add secret: string to rpcRequest's argument object and use it at line 70. Both call sites pass one: deps.secret from packages/guardrail/src/gateway.ts:222, and env.envelopeSecret() from apps/web/src/gateway/deps.ts:34.

NoteConfirmed; low is correct. Today both resolve to the same string so nothing is broken, but this is also the concrete thing that makes the rotation fix above harder than it looks - the accepted-keys list would have to be threaded through here too.

low
No test covers the bus: no redelivery, dedupe, subject-binding or bootstrap-idempotency test exists
Bus
packages/transport/src/serve.ts:60
Whentests/ contains exactly one file, registry-derive.test.ts. Nothing exercises the guarantees this dimension rests on: that a redelivered command does not create a second invitation, that a valid rpc envelope replayed onto a cmd subject is refused by the subject check (service.ts:247-253), that ensureStreams is genuinely idempotent, or that a handler throw leads to redelivery with the configured backoff. Every finding above is therefore a production discovery.

FixAdd tests/ cases running against the docker-compose NATS: publish the same command twice with the same requestId and assert one invitation row; publish a valid rpc envelope onto the cmd subject and assert the UNTRUSTED_ENVELOPE refusal; run ensureStreams twice and assert consumer/stream config is unchanged; force a handler throw and assert redelivery timing matches the configured backoff.

NoteConfirmed - ls tests/ returns only registry-derive.test.ts.

low
AuthGate is exported and documented but imported nowhere, and no UI test exercises it
Client mirror
packages/ui/src/components/auth-gate.tsx:21
WhenVerified: packages/ui/package.json:11 exports ./auth-gate and the skill documents it as a first-class primitive, but a grep across apps/ and packages/ finds zero importers; the only test file in the repo is tests/registry-derive.test.ts, so the roleAtLeast wiring at auth-gate.tsx:33 — including the role === undefined branch — has never executed. Meanwhile member-list.tsx:33-36 reads useViewer().role by hand, and billing/page.tsx renders checkout UI to any admin though billing:manage is minRole "owner" (registry.ts:288-296) while billing:read is "admin".

FixWrap the plan-changing part of apps/web/src/app/(dashboard)/billing/page.tsx in <AuthGate role="owner" fallback={<p className="text-sm text-muted-foreground">Ask an owner to change the plan.</p>}> — the one genuine role-only surface in the repo. Add a packages/ui test package (vitest + @testing-library/react) covering AuthGate's three branches and Gate's fallback forwarding.

NoteConfirmed, including the billing minRole split at registry.ts:280-296, which makes the suggested call site real rather than invented. Low: nothing is wrong today, it is unexercised surface.

low
<Gate> applies the allowance check to operations the gateway never limits, hiding the delete button that would free the allowance
Client mirror
packages/ui/src/components/gate.tsx:38
Whenpackages/ui/src/components/gate.tsx:34-42 composes AccessGate -> FeatureGate -> PriceGate for every (resource, operation) pair with no reference to ruleFor(resource, operation).consumes, while packages/guardrail/src/gateway.ts:181 applies the plan gate only when consumes is true. PriceGate (price-gate.tsx:41) renders the upgrade prompt whenever the decision is limit_reached, regardless of operation. So <Gate resource="project" operation="delete"> for a Pro org at 25/25 renders an upgrade prompt instead of the Delete button — the platform would happily execute the delete, and the delete is the one action that would put them back under the cap. FeatureGate has the mirror problem: <Gate resource="organization" operation="read"> is not_in_plan for every free org (registry.ts:110).

Fixpackages/ui/src/components/gate.tsx — import ruleFor from @guardrail/registry (client-safe; the package header at define.ts:9 guarantees no server-only import) and render FeatureGate/PriceGate only when ruleFor(resource, operation).consumes is true, passing children straight through AccessGate otherwise. That makes the composed gate apply exactly the checks packages/guardrail/src/gateway.ts applies.

NoteThe code behaviour is confirmed. Severity downgraded medium -> low: grep shows the only <Gate> call site in the app is project/create (apps/web/src/features/projects/project-list.tsx:50), which IS consumes:true, and member-list.tsx uses PriceGate directly on member (also consumes). So this is a latent trap in the shared component, not a live wrong screen — but it is exactly the component the client-mirror skill points people at first.

low
UpgradePrompt uses a raw <a> with a possibly-undefined href and a title-only tagline
Client mirror
packages/ui/src/components/upgrade-prompt.tsx:41
WhenVerified: billingHref at line 21 is NAV_ITEMS.find(…)?.href, typed string | undefined; if billing's nav were ever set to null (organization, membership and invitation already are, registry.ts:112/143/270) the component renders <a> with no href — not focusable, not keyboard-activatable, no compile error. Line 40 uses a raw <a> rather than next/link, so the product's primary upsell click is a full document reload that drops client state and is never checked by typedRoutes (next.config.ts:4). The tagline at line 43 lives only in a title attribute, unavailable to keyboard and touch users.

Fixpackages/ui/src/components/upgrade-prompt.tsx: fall back to the muted-paragraph branch when billingHref === undefined (same shape as the next === null branch at line 33), swap <a> for next/link, and render PLANS[next].tagline as visible text instead of title. Widening the prop to AccessDecision and returning null when allowed would also remove the hand-narrowing ternary at project-list.tsx:53.

NoteConfirmed as written; the undefined-href half is latent (billing nav is set at registry.ts:299). The next/link and title-attribute halves are live on every upsell click. Low is right.

low
countSeats fetches every member row to compute a count, and runs on every organisation read
Identity
services/identity/src/identity.service.ts:35
WhenConfirmed: countSeats (35-41) selects { id: member.id } for the whole org and returns rows.length. It is called by organizationWithCount:136 (organization.read) and updateOrganization:186. A 5,000-seat tenant transfers and parses 5,000 rows on every /team and /settings load, against organization.read's registry budget — and with no index on member(organization_id) it is a sequential scan as well. projectService.countActive at services/projects/src/project.service.ts:49-55 already shows the correct shape.

FixReplace the body of countSeats in services/identity/src/identity.service.ts with const [row] = await db.select({ value: count() }).from(member).where(eq(member.organizationId, organizationId)); return row?.value ?? 0; and add count to the drizzle-orm import on line 12.

NoteExact. Low is right — it is wasteful, not wrong.

low
Organisation slug uniqueness: check-then-insert races to an unhandled unique violation surfaced as INTERNAL
Identity
services/identity/src/index.ts:142
WhenSplit verdict. The race is confirmed: index.ts:142 (create) and :156 (update) call identityService.slugTaken, which is an unscoped SELECT on organization.slug (identity.service.ts:139-146), then insert/update; organization.slug is .unique() (schema.ts:15) and createOrganization (:153-174) does not catch 23505, so two concurrent creates of the same slug give the loser a raw Postgres error mapped to INTERNAL by service.ts:307-308 instead of CONFLICT. The cross-tenant existence-oracle half is refuted as a *finding about slugTaken*: superseded.ts:78 deliberately keeps /api/auth/organization/check-slug mounted ("Read-only availability check. No tenant data crosses it."), which is the same global lookup exposed directly and un-rate-limited by the registry, so removing slugTaken changes nothing about what an enumerator can learn.

FixIn services/identity/src/identity.service.ts, drop slugTaken and let the database decide: wrap the insert in createOrganization and the update in updateOrganization in try/catch and map Postgres error code 23505 to ServiceError("CONFLICT", The slug '<slug>' is already taken.). That closes the race and removes the second query in one change. If the oracle genuinely matters for the product, the file to change is apps/web/src/app/api/auth/superseded.ts — move organization/check-slug from KEPT to SUPERSEDED — not identity.service.ts.

NoteConfirmed for the race/INTERNAL half; the oracle half is refuted (already deliberately exposed via a KEPT Better Auth endpoint, so it is not a defect in this file). Low is right.

low
A command envelope that can never verify is redelivered five times instead of being dropped
Identity
services/identity/src/index.ts:216
WhenThe CMD consumer handler throws whenever runtime.handle returns a refusal: if (!reply.ok) throw new Error(reply.error.message). A command envelope that fails signature verification, or is refused PERMISSION_DENIED at service.ts:198, is deterministically unverifiable - retrying it cannot change the outcome - yet it is nak'd and redelivered up to max_deliver 5 times (serve.ts:71-72,91), burning five verification cycles and five error logs on bytes that will never be accepted. This directly contradicts the rule defineConsumer states for the evt path at service.ts:322-323 ('a message that fails any check here is dropped rather than thrown, so JetStream acks it instead of redelivering forged bytes five times'); the cmd path never got the same treatment.

Fixservices/identity/src/index.ts:214-217: ack and log instead of throwing when reply.error.code is one of the terminal codes (UNTRUSTED_ENVELOPE, PERMISSION_DENIED, INVALID_INPUT, NOT_FOUND), and throw only for INTERNAL and SERVICE_UNAVAILABLE, which are the codes a redelivery can actually fix. Better still, move that decision into defineService in packages/guardrail/src/service.ts so the next service with a command handler inherits it rather than copying this block.

low
member.role is an unconstrained text column and normalizeRole takes the highest claimed role across a comma list
Identity
services/identity/src/schema.ts:32
WhenConfirmed at the schema level, but no in-product write path reaches it. member.role is text().notNull().default("member") with no CHECK and no FK (schema.ts:32), and normalizeRole (derive.ts:216-223) splits on "," and returns the highest recognised token, so a row reading "member,owner" makes that user an owner: identity.ts:40 signs role owner into the envelope and service step 5/5b re-reads the same signed meta and agrees. What I could not reproduce is any writer that can produce such a value: setMemberRole and createInvitation take role from contracts that are z.enum(ORG_ROLES) (identity.contract.ts:18,:36,:44), the auth.ts:99 hook writes HIGHEST_ROLE, and Better Auth's own invite-member / update-member-role endpoints are superseded (superseded.ts:51-53). The remaining writers are Better Auth's accept-invitation (which copies an already-enum-validated invitation.role) and anything outside the app: a migration, a support script, an operator.

FixAdd a CHECK constraint on member.role restricted to ORG_ROLES in services/identity/src/schema.ts and the matching Better Auth schema in packages/auth/src/schema.ts, generated from the registry so it cannot drift. Leave normalizeRole's comma handling alone unless the Better Auth multi-role write it documents is confirmed to be unreachable — narrowing it to LOWEST_ROLE on an unrecognised value would, if that write does happen, silently strip an owner instead.

NoteDowngraded medium → low and marked PLAUSIBLE: the escalation is real only if something outside the app writes the column, which I cannot rule in or out from the repo. The proposed normalizeRole change is riskier than the finding admits — derive.ts:210-214 says the max-wins behaviour exists because Better Auth writes comma lists, so flipping it to fail-closed could demote real owners. The CHECK constraint is the safe half.

low
SIGTERM handler can never exit when the NATS connection failed, leaving the process to be SIGKILLed
Projects
services/projects/src/index.ts:53
Whenprocess.on("SIGTERM", () => void closeConnection().then(() => process.exit(0))) in all four services. packages/transport/src/connection.ts:65 does await (await pending).drain(); if the stored promise is a rejection (NATS unreachable at boot, see the cached-rejection finding) closeConnection() rejects, .then(process.exit(0)) never runs, and the void swallows it into an unhandled rejection. The pod ignores SIGTERM entirely and waits out the full termination grace period before SIGKILL - during a rolling deploy that is 30s of dead pod per replica, and any node draining logic sees a container that will not stop.

FixWrap the shutdown in packages/transport/src/connection.ts (try { await (await pending).drain() } catch {}) and, in each services/*/src/index.ts, replace the .then(process.exit(0)) chain with an async handler that always exits (try { await shutdown() } finally { process.exit(0) }) plus a hard setTimeout(() => process.exit(1), 10_000).unref() watchdog.

low
A malformed pagination cursor from the client becomes an INTERNAL 500
Projects
services/projects/src/project.service.ts:26
WhenConfirmed. packages/contracts/src/resources/project.contract.ts:26 types cursor as z.string().nullish() with no format constraint, so any string passes the gateway and the service parse. project.service.ts:26 does lt(project.createdAt, new Date(args.cursor)); for cursor='abc' that is an Invalid Date, and drizzle's mapToDriverValue (pg-core/columns/timestamp.js) calls value.toISOString(), which throws RangeError. Not a ServiceError, so packages/guardrail/src/service.ts:307-308 logs and returns INTERNAL -> a 500 for a client input error, plus error-log noise that masks genuine INTERNALs.

FixConstrain the cursor in packages/contracts/src/resources/project.contract.ts:26 (a refined string matching the composite-cursor format from the cursor finding) so the gateway refuses it as INVALID_INPUT before the bus, and add a defensive if (Number.isNaN(at.getTime())) throw new ServiceError('INVALID_INPUT', 'Invalid cursor.') in services/projects/src/project.service.ts.

NoteExact and reproducible from the code paths read. Low is right.

low
The HTTP edge has no tests
Tests
tests/registry-derive.test.ts:1 · reported by 4 auditors (gateway-http-web, crypto-envelope-replay, rate-limiting-abuse, auth-session-identity)
AlsoNo test covers signing, MAC domain separation, canonicalisation or freshness  ·  No test covers the limiter, the fail-open path or the window boundary  ·  The auth surface has no tests at all

Whentests/ contains exactly one file, registry-derive.test.ts. The whole trust boundary rests on properties asserted only in comments: that an event MAC cannot verify as a request MAC (envelope.ts:187-195), that {"__proto__":{"role":"owner"}} does not hash the same as {} (envelope.ts:144-153), that a reply captured for one operation fails verifyReply against another (envelope.ts:238-242), and that a widened deadlineAt is refused (derive.ts:378-381). A refactor that drops the domain field, or a zod upgrade that changes how explicitly-undefined keys survive parse, ships green - which is how the canonicalise crash above went unnoticed.

FixAdd tests/envelope-signing.test.ts beside registry-derive.test.ts with those four cases plus a round trip through JSON.parse(JSON.stringify(payload)) asserting that the gateway-side and service-side canonical forms are byte-identical for every contract input in packages/contracts/src/resources/.

NoteConfirmed - tests/ holds one file. The round-trip case in the proposed fix would also have caught the z.date() wire-form defect listed under missed.

low
There is no test anywhere for entitlements, metering or the plan gate
Tests
tests/registry-derive.test.ts:42
Whentests/ contains exactly one file, tests/registry-derive.test.ts, and it covers checkResourceAccess as a pure function over hand-written entitlements (the auditLog not_in_plan case is at line 42, the project limit_reached case at line 54). Nothing tests that the gateway refuses at the cap, that the entitlements cache degrades correctly, that the Autumn adapter maps a {data:null,error} container to a refusal rather than to DEFAULT_PLAN, or that the meter fires exactly once per event. Every critical finding above would have been caught by one integration test, and every one can regress silently.

FixAdd tests/billing-entitlements.test.ts beside the existing file, in the same runner-free style (plain node:assert, run with pnpm tsx): a fake entitlements dep proving packages/guardrail/src/gateway.ts refuses at the cap and refuses not_in_plan for non-consuming reads; and a fake global fetch returning a 404 body proving packages/billing/src/autumn.adapter.ts throws rather than returning DEFAULT_PLAN. Register it wherever the existing test is invoked (package.json / Makefile).

NoteConfirmed — tests/ has exactly one file and the cited line numbers are correct.

low
The cross-service boundary disables itself if the checkout path contains a 'services' segment
Enforcement
tools/guardrail-check.ts:209
WhenVerified: SERVICE_PATH (line 209) is unanchored and both own (line 220) and serviceTargetOf (line 215-216) run it against absolute paths built from process.cwd(). Under /srv/services/guardrail-platform every file's own resolves to "guardrail-platform", and a genuine violation - services/projects/src/x.ts importing "../../identity/src/db" - resolves to a path whose first services/ segment is also "guardrail-platform", so target === own and line 224 skips it. The rule fails open and prints 'architecture intact'. The same absolute-path matching makes noRawSubjects' exemption (line 447) and noBusinessLogicInGateway's scope (line 287) path-dependent.

Fixtools/guardrail-check.ts: run the path regexes against relative(ROOT, file) at lines 215, 220, 287, 447 and 462, and anchor SERVICE_PATH to /^services[/\\]([^/\\]+)/.

NoteCode defect confirmed by reading; whether any deployment checks out under such a path I cannot verify, so treat the trigger as PLAUSIBLE. Downgraded medium -> low on that basis - but note the failure is silent and green, which is why it is worth the one-line fix.

low
Contract rules are keyed on the *.contract.ts filename
Enforcement
tools/guardrail-check.ts:413
WhenVerified: contractInputs returns unless /\.contract\.ts$/ matches, and packages/contracts/src/contracts.ts:15-19 imports each resource by explicit path, so packages/contracts/src/resources/organization.ts would satisfy ContractMap identically with no org-id and no indirection check. Confirmed there is no rule anywhere enforcing the naming.

Fixtools/guardrail-check.ts: key contractInputs on location - apply it to every file under packages/contracts/src/resources/ - and add a companion rule that every specifier imported by packages/contracts/src/contracts.ts resolves inside that directory. Keep the .contract.ts suffix as an additional naming rule reporting files in resources/ that do not follow it.

NoteMechanism confirmed. Downgraded high -> low: it requires deliberately deviating from a convention every existing file and the add-feature skill follow, and it only removes a defence-in-depth rule (see the org-id finding).

low
The no-raw-subjects backstop misses subjects built by concatenation
Enforcement
tools/guardrail-check.ts:441
WhenVerified: RAW_SUBJECT (line 441-444) anchors on the opening quote followed by rpc|cmd|evt, so it catches "rpc.project.read" and rpc.${r}.${o} but not "rpc." + resource + "." + operation, not ["rpc",r,o].join("."), and not const P="rpc" followed by ${P}.${r}.${o}. tools/grit/no-raw-subjects.grit carries the identical anchor. A subject assembled that way compiles and passes verify, and a typo in it produces a request that hangs for the full timeoutMs and returns SERVICE_UNAVAILABLE - the exact failure the rule's header describes.

Fixtools/guardrail-check.ts: add an AST pass over the already-parsed tree flagging any BinaryExpression or .join() whose leftmost operand is a string literal matching /^(rpc|cmd|evt)\.?$/, and any string literal equal to "rpc"/"cmd"/"evt" outside packages/registry and packages/transport (reusing the exemption at line 447).

NoteConfirmed; low is the right severity - the consequence is a timeout, not a security or data failure.

low
no-data-in-derive only detects plan keys used as object keys in derive.ts
Enforcement
tools/guardrail-check.ts:463
WhenVerified: the rule is scoped to files ending registry/src/derive.ts (line 462) and the regex is /^\s*(free|pro|scale)\s*:/m built from the live plan keys, so const PROJECT_LIMITS = [["free",2],["pro",25]] in derive.ts is not matched, a new packages/registry/src/limits.ts is not scanned, and a limit or minRole hardcoded in apps/web or a service is entirely outside the rule. The drift consequence is real: the browser's Gate and the gateway both call checkResourceAccess (derive.ts:259), so a second hardcoded limit anywhere makes the button and the refusal disagree.

Fixtools/guardrail-check.ts: widen noDataInDerive to every file under packages/registry/src/ except registry.ts, and match plan keys as string literals as well as object keys. Add a second rule flagging string literals equal to a PLAN key or an ORG_ROLE outside packages/registry (the plan list is already loaded at runtime by planKeysFromRegistry, line 160).

NoteConfirmed. Downgraded medium -> low: no duplicated data exists today and the failure needs somebody to hand-write a limit that derive.ts could compute.

low
The Better Auth mount check verifies only that route.ts imports superseded.ts
Enforcement
tools/guardrail-check.ts:810
WhenVerified: mountReachesTheWrapper (line 810-824) passes as soon as some relative specifier in a file that calls toNextJsHandler resolves to the table module - it never checks that supersedes is called or that the exported GET/POST reach it. A rewrite that keeps a decorative import { SUPERSEDED } for a log line satisfies both this rule and Biome's noUnusedImports, re-opening all eleven refused paths including organization/create and organization/delete. Confirmed there is no test anywhere asserting the 410. Note the finding's line number was 805 (a comment); the function starts at 810.

Fixtools/guardrail-check.ts: in mountReachesTheWrapper require a CallExpression on the supersedes binding imported from the table module, and that every exported GET/POST body reaches it, not merely that the module is imported. Add tests/auth-supersession.test.ts calling the exported GET with a Request for /api/auth/organization/create and asserting status 410.

NoteConfirmed, line corrected to 810. Downgraded medium -> low: the bypass needs somebody to rewrite route.ts while deliberately retaining an otherwise-pointless import; the honest failure mode (dropping the import) is caught.

How this was produced
Eleven auditors ran in parallel, one per dimension: envelope and MAC handling, authentication and sessions, multi-tenancy, plan gating and billing, rate limiting and abuse, NATS and JetStream, database and migrations, the HTTP edge, the client mirror, the enforcement ladder, and operations. Each read the real files. Each finding then went to a second agent whose instruction was to refute it — open the file, reproduce the reasoning, and mark it refuted if the code already handles it or the scenario cannot occur. Several claims died there, and several severities moved in both directions; a number of verifiers went further and executed the installed dependency to check a behaviour rather than assuming it, which is where the z.date(), Autumn customer-scope and Better Auth limiter findings came from.

243 verified findings clustered to 188 distinct anchors. A twelfth pass — a completeness critic asked what the eleven dimensions had missed — was stopped after it stalled; the dimensions' own "missed" entries are included.

Nothing in the repository was changed. No file was written, no command with a side effect was run, and no git command was issued. Every fix above is a description, not a diff.

Guardrail Readiness Audit · findings pinned to main as it stood during the run, while another process was concurrently editing the tree. Re-check anchors before applying a fix.