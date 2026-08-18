/**
 * SOT: auth, better-auth, auth-instance, organization-plugin, invitations, sessions
 * WHAT   The Better Auth instance. Runs in the gateway only.
 * WHY    Auth owns cookies and HTTP routes, so it lives where HTTP lives. Services never
 *        see a session - they see a signed envelope, which is the whole point of the split.
 * WHERE  apps/web/src/app/api/auth/[...all]/route.ts, @guardrail/auth/identity.ts
 */
import "server-only";

import { autumn } from "autumn-js/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";

import { createDb } from "@guardrail/db";
import { env } from "@guardrail/env";
import { ac, roles } from "@guardrail/registry/access";

import * as schema from "./schema";

export const authDb = createDb(schema);

export const auth = betterAuth({
  appName: "Guardrail",
  secret: env.betterAuthSecret(),
  baseURL: env.appUrl(),
  database: drizzleAdapter(authDb, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  session: { expiresIn: 60 * 60 * 24 * 30, cookieCache: { enabled: true, maxAge: 60 } },
  databaseHooks: {
    session: {
      create: {
        /** No active organisation means no envelope can be built, so pick one at sign-in. */
        before: async (session) => {
          const membership = await authDb.query.member.findFirst({
            where: (table, { eq }) => eq(table.userId, session.userId),
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
      creatorRole: "owner",
      invitationExpiresIn: 60 * 60 * 48,
      async sendInvitationEmail(data) {
        // Delivery is the identity service's job, driven by evt.member.create.
        console.info(`[invitation] queued for ${data.email}`);
      },
    }),
    autumn(),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
