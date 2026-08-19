/**
 * SOT: root-layout, app-shell, providers
 * WHAT   The document shell and the one provider the whole app needs.
 * WHY    Deliberately thin. A provider here runs for every route including /sign-in, so the
 *        only thing that belongs is the tRPC client. `AutumnProvider` used to sit here to
 *        feed the vendor's own <PricingTable/>, which called billing endpoints mounted
 *        outside the block - no role gate, no rate limit, no audit row. Autumn is still the
 *        billing vendor; it is reached through its adapter over the bus, via billing.manage
 *        like every other mutation.
 * HOW    Anything reading an environment variable here must go through @guardrail/env, not
 *        `process.env` - this file is a .tsx, which the no-process-env plugin did not cover
 *        until that glob was widened.
 * WHERE  apps/web/src/trpc/react.tsx, apps/web/src/features/billing/plan-table.tsx
 */
import type { Metadata } from "next";

import { TRPCReactProvider } from "@/trpc/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Guardrail",
  description: "A SaaS platform where the architecture enforces itself.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Autumn is still the billing vendor, but it is reached through its adapter over
            the bus, not through a provider in the browser. `AutumnProvider` existed to feed
            the vendor's own <PricingTable/>, which called endpoints mounted outside the
            block. Checkout now goes through billing.manage like every other mutation. */}
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
