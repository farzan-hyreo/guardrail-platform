/**
 * SOT: auth, better-auth, auth-instance, organization-plugin, invitations, sessions
 * WHAT   The Better Auth instance. Runs in the gateway only.
 * WHY    Auth owns cookies and HTTP routes, so it lives where HTTP lives. Services never
 *        see a session - they see a signed envelope, which is the whole point of the split.
 * HOW    Neither this module nor `authDb` is reachable from a public entry point. The
 *        instance is re-exported by server.ts alone, which exactly one route file imports,
 *        because anything apps/web can import can issue cross-tenant SQL from the layer
 *        whose whole claim is that it has no database.
 * WHERE  server.ts, identity.ts
 */
import "server-only";

import { createDb } from "@guardrail/db";
import { env } from "@guardrail/env";
import { HIGHEST_ROLE } from "@guardrail/registry";
import { ac, roles } from "@guardrail/registry/access";
import { autumn } from "autumn-js/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";

import * as schema from "./schema";
import { SESSION_COOKIE_PREFIX } from "./session-cookie";

export const authDb = createDb(schema);

const SECONDS_PER_DAY = 60 * 60 * 24;

/** Lowercase, hyphenated, no runs and no edges - the same shape the contract's slug accepts. */
function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "workspace" : cleaned.slice(0, 32);
}

/** A name somebody will recognise on their first screen, from whatever signup gave us. */
function workspaceName(name: string | null | undefined, email: string): string {
  const person = name?.trim();
  if (person !== undefined && person.length > 0) return `${person}'s workspace`;
  const local = email.split("@")[0];
  return local === undefined || local.length === 0 ? "My workspace" : `${local}'s workspace`;
}

export const auth = betterAuth({
  appName: "Guardrail",
  secret: env.betterAuthSecret(),
  baseURL: env.appUrl(),
  database: drizzleAdapter(authDb, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  /**
   * Seven days, refreshed at most once a day. `cookieCache.maxAge` is the window in which a
   * revoked session is still honoured, because the cookie answers instead of the database:
   * it is the time the platform is blind to a sign-out or a removed membership, so it is
   * kept to half a minute rather than traded for a few saved reads.
   */
  session: {
    expiresIn: SECONDS_PER_DAY * 7,
    updateAge: SECONDS_PER_DAY,
    cookieCache: { enabled: true, maxAge: 30 },
  },
  /** Declared, not defaulted, so @guardrail/auth/session and the cookie stay the same name. */
  advanced: { cookiePrefix: SESSION_COOKIE_PREFIX },
  databaseHooks: {
    user: {
      create: {
        /**
         * Every user gets a workspace the moment they exist.
         *
         * This replaces `organization/create` as the path a new user takes, and that is the
         * point: that endpoint was mounted straight onto /api/auth with no role gate, no
         * rate limit keyed on anything that existed, no plan gate and no audit row, so any
         * signed-in user could loop it and mint tenants without limit. Creating the first
         * one here means the only user-callable way to make an organisation is
         * `organization.create`, which the registry gates at owner and counts against the
         * plan.
         *
         * It also closes the other half: the session hook below returns a null active
         * organisation when a user has no membership, which produced a sign-in redirect
         * loop for every new account. After this there is always one.
         */
        after: async (created) => {
          const name = workspaceName(created.name, created.email);
          const organizationId = crypto.randomUUID();
          await authDb.insert(schema.organization).values({
            id: organizationId,
            name,
            // Suffixed, not checked-and-retried: the column is unique and a collision here
            // would fail a signup rather than a request somebody can repeat.
            slug: `${slugify(name)}-${organizationId.slice(0, 8)}`,
          });
          await authDb.insert(schema.member).values({
            id: crypto.randomUUID(),
            organizationId,
            userId: created.id,
            role: HIGHEST_ROLE,
          });
        },
      },
    },
    session: {
      create: {
        /**
         * No active organisation means no envelope can be built, so pick one at sign-in.
         * Ordered by join date: an unordered findFirst lets Postgres decide which tenant a
         * multi-org user lands in, and nothing stops it deciding differently next time.
         */
        before: async (session) => {
          const membership = await authDb.query.member.findFirst({
            where: (table, { eq }) => eq(table.userId, session.userId),
            orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
          });
          return { data: { ...session, activeOrganizationId: membership?.organizationId ?? null } };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: HIGHEST_ROLE,
      invitationExpiresIn: 60 * 60 * 48,
      sendInvitationEmail(data) {
        // Delivery is the identity service's job, driven by evt.member.create.
        console.info(`[invitation] queued for ${data.email}`);
        return Promise.resolve();
      },
    }),
    autumn(),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
