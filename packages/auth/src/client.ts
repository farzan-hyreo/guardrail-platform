/**
 * SOT: auth-client, better-auth-client, sign-in, org-client
 * WHAT   Browser auth client sharing the registry's access control with the server.
 * WHERE  apps/web components
 */
"use client";

import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, roles } from "@guardrail/registry/access";

export const authClient = createAuthClient({
  baseURL: process.env["NEXT_PUBLIC_APP_URL"],
  plugins: [organizationClient({ ac, roles })],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
