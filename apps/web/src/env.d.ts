/**
 * SOT: client-env, next-public-env
 * WHY   `noPropertyAccessFromIndexSignature` forbids `process.env.FOO`, but Next only
 *       inlines NEXT_PUBLIC_ variables when they are written with dot access. Declaring
 *       them here makes them real properties rather than index-signature lookups, so both
 *       constraints hold at once. Server-side variables go through @guardrail/env instead.
 */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly NEXT_PUBLIC_APP_URL: string;
    }
  }
}

export {};
