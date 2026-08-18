/**
 * SOT: env, environment-variables, config, secrets
 * WHAT   Every environment variable the platform reads, in one place, read once.
 * WHY    Two reasons. A missing secret should fail at boot, not on a customer's request.
 *        And `noPropertyAccessFromIndexSignature` makes `process.env.FOO` a type error, so
 *        centralising the bracket access here keeps that strictness free everywhere else.
 * HOW    Adding a variable is one line here plus one in .env.example. Nothing else reads
 *        process.env - a lint rule enforces that. A variable the browser reads is spelled
 *        out literally instead of going through `required`; see `publicAppUrl`.
 * WHERE  every server package, plus @guardrail/auth/client in the browser
 */
function requireValue(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function required(name: string): string {
  return requireValue(name, process.env[name]);
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * The one variable that reaches the browser, and the only one whose key is written out in
 * full. Next substitutes `NEXT_PUBLIC_*` into the client bundle by matching the literal text
 * of the key - `getNextPublicEnvironmentVariables` in next/dist/lib/static-env.js emits one
 * define per key - and never defines `process.env` as an object. So `required(name)`, which
 * reads `process.env[name]` dynamically, yields undefined in the browser and throws on
 * import. Keep this key literal. Do not route it through `required`.
 *
 * biome.json turns complexity/useLiteralKeys off for THIS FILE, because its suggested
 * rewrite to `process.env.NEXT_PUBLIC_APP_URL` is TS4111 under
 * `noPropertyAccessFromIndexSignature` - `make fix` runs biome with --unsafe and would
 * otherwise apply it and break the build. biome.json takes neither comments nor unknown
 * keys, so the reason lives here.
 */
function publicAppUrl(): string {
  return requireValue("NEXT_PUBLIC_APP_URL", process.env["NEXT_PUBLIC_APP_URL"]);
}

export const env = {
  /** Same value in the gateway and every service, or services reject every envelope. */
  envelopeSecret: (): string => required("ENVELOPE_SECRET"),
  databaseUrl: (): string => required("DATABASE_URL"),
  natsUrl: (): string => optional("NATS_URL") ?? "nats://localhost:4222",
  /** Names the NATS credential this process holds. See infra/nats/auth.conf. */
  natsUser: (): string => optional("NATS_USER") ?? optional("SERVICE_NAME") ?? "gateway",
  /**
   * The private half of that credential. The bus refuses an unauthenticated connection, so
   * a deployment without one fails at boot rather than on a customer's request.
   */
  natsNkeySeed: (): string | null => {
    const seed = optional("NATS_NKEY_SEED");
    if (seed === null && process.env["NODE_ENV"] === "production") {
      throw new Error("Missing NATS_NKEY_SEED. The bus authenticates; see infra/nats/RUNBOOK.md.");
    }
    return seed;
  },
  /** Browser-safe. Anything shipped to the client must call this one. */
  publicAppUrl,
  /** The server-side name for the same read, so the two can never drift apart. */
  appUrl: publicAppUrl,
  betterAuthSecret: (): string => required("BETTER_AUTH_SECRET"),
  autumnSecretKey: (): string | null => optional("AUTUMN_SECRET_KEY"),
  upstash: (): { url: string; token: string } | null => {
    const url = optional("UPSTASH_REDIS_REST_URL");
    const token = optional("UPSTASH_REDIS_REST_TOKEN");
    return url === null || token === null ? null : { url, token };
  },
  serviceName: (): string => optional("SERVICE_NAME") ?? "gateway",
  isProduction: (): boolean => process.env["NODE_ENV"] === "production",
  rateLimitInDev: (): boolean => optional("RATE_LIMIT_DEV") === "on",
  /** Opt-out for a genuine single-instance deploy with no Upstash. See `ratelimit.ts`. */
  rateLimitAllowInMemory: (): boolean => optional("RATE_LIMIT_ALLOW_IN_MEMORY") === "on",
} as const;
