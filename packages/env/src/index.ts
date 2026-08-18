/**
 * SOT: env, environment-variables, config, secrets
 * WHAT   Every environment variable the platform reads, in one place, read once.
 * WHY    Two reasons. A missing secret should fail at boot, not on a customer's request.
 *        And `noPropertyAccessFromIndexSignature` makes `process.env.FOO` a type error, so
 *        centralising the bracket access here keeps that strictness free everywhere else.
 * HOW    Adding a variable is one line here plus one in .env.example. Nothing else reads
 *        process.env - a lint rule enforces that.
 * WHERE  every server package
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? null : value;
}

export const env = {
  /** Same value in the gateway and every service, or services reject every envelope. */
  envelopeSecret: (): string => required("ENVELOPE_SECRET"),
  databaseUrl: (): string => required("DATABASE_URL"),
  natsUrl: (): string => optional("NATS_URL") ?? "nats://localhost:4222",
  appUrl: (): string => required("NEXT_PUBLIC_APP_URL"),
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
} as const;
