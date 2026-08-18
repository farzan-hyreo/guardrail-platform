/**
 * SOT: database, drizzle-factory, db-connection, service-isolation
 * WHAT   A factory, not a client. Each service builds its own instance over its own schema.
 * WHY    Service isolation. There is no shared `db` object to import, so no service can
 *        read another's tables by accident - the type simply does not exist over there.
 *        The gateway does not depend on this package at all: its package.json has no line
 *        for it, which is a stronger guarantee than any lint rule.
 * HOW    createDb(schema) in the owning service. Migrations live with the service too.
 * WHERE  services/<name>/src/db.ts, @guardrail/auth
 */
import "server-only";

import { env } from "@guardrail/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// Env lives in @guardrail/env. This package only builds clients.

const pools = new Map<string, Pool>();

function poolFor(url: string): Pool {
  const existing = pools.get(url);
  if (existing) return existing;
  const pool = new Pool({ connectionString: url, max: 10 });
  pools.set(url, pool);
  return pool;
}

export function createDb<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  url = env.databaseUrl(),
) {
  return drizzle(poolFor(url), { schema });
}

export * from "drizzle-orm";
