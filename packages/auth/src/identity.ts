/**
 * SOT: identity, identity-adapter, normalize-identity, gateway-identify
 * WHAT   Turns a Better Auth session into the flat shape the gateway block needs.
 * WHY    Normalised identity: `GatewayDeps.identify` is the only signature the block knows.
 *        Moving to Clerk or WorkOS means rewriting this function and nothing else - no
 *        service, no router, no component mentions a provider.
 * WHERE  apps/web/src/gateway/deps.ts
 */
import "server-only";

import { and, eq } from "@guardrail/db";
import type { GatewayIdentity } from "@guardrail/guardrail";
import { normalizeRole } from "@guardrail/registry";

import { auth, authDb } from "./auth";
import { member } from "./schema";

export async function identify(headers: Headers): Promise<GatewayIdentity | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;

  const orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) return null;

  const [row] = await authDb
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, session.user.id), eq(member.organizationId, orgId)))
    .limit(1);

  // Membership is verified against the row, not taken from the session claim alone.
  if (!row) return null;

  return { userId: session.user.id, orgId, role: normalizeRole(row.role) };
}
