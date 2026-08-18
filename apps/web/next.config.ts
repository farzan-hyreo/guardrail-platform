import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  transpilePackages: [
    "@guardrail/registry",
    "@guardrail/contracts",
    "@guardrail/guardrail",
    "@guardrail/transport",
    "@guardrail/auth",
    "@guardrail/billing",
    "@guardrail/ui",
  ],
};

export default nextConfig;
