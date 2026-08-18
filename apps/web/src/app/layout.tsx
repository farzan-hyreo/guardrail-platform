import type { Metadata } from "next";
import { AutumnProvider } from "autumn-js/react";

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
        <AutumnProvider betterAuthUrl={process.env.NEXT_PUBLIC_APP_URL}>
          <TRPCReactProvider>{children}</TRPCReactProvider>
        </AutumnProvider>
      </body>
    </html>
  );
}
