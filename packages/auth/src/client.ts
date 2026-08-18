/**
 * SOT: auth-client, better-auth-client, sign-in, org-client
 * WHAT   Browser auth client sharing the registry's access control with the server.
 * WHY    The options and the client are annotated rather than inferred: better-auth's
 *        organisation plugin returns atoms declared in an internal module no consumer can
 *        name, so an inferred type here is unportable (TS2742). Naming the two better-auth
 *        types keeps the whole chain printable without a cast.
 * WHERE  apps/web components
 */
"use client";

import { env } from "@guardrail/env";
import { ac, roles } from "@guardrail/registry/access";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

type OrganizationPlugin = ReturnType<
  typeof organizationClient<{ ac: typeof ac; roles: typeof roles }>
>;

type AuthClientOptions = { baseURL: string; plugins: [OrganizationPlugin] };

const clientOptions: AuthClientOptions = {
  baseURL: env.publicAppUrl(),
  plugins: [organizationClient({ ac, roles })],
};

export const authClient: ReactAuthClient<AuthClientOptions> = createAuthClient(clientOptions);

export const { signIn, signUp, signOut, useSession, organization } = authClient;
