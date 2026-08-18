/**
 * SOT: nats, nats-connection, transport-connection, jetstream-client
 * WHAT   One NATS connection per process, plus the JetStream handles.
 * WHY    Connections are expensive and Next.js hot-reloads modules; a global keeps dev
 *        from opening a connection per edit.
 * HOW    nats.js v3 splits the client: `connect` from the node transport, `jetstream` and
 *        `jetstreamManager` from the JetStream module. This file is the only place that
 *        knows that. Swapping to another broker means rewriting this file and request.ts.
 * WHERE  @guardrail/transport/*, services/*, scripts/bootstrap-streams.ts
 */
import "server-only";

import { env } from "@guardrail/env";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";

/**
 * Declared rather than asserted. Next.js re-evaluates modules on every hot reload, so
 * without this the dev server opens a new NATS connection per edit.
 */
declare global {
  var __guardrailNats: Promise<NatsConnection> | undefined;
}

export const natsUrl = env.natsUrl;

export async function connection(): Promise<NatsConnection> {
  globalThis.__guardrailNats ??= connect({
    servers: natsUrl(),
    name: env.serviceName(),
    maxReconnectAttempts: -1,
    reconnectTimeWait: 500,
  });
  return globalThis.__guardrailNats;
}

export async function js(): Promise<JetStreamClient> {
  return jetstream(await connection());
}

export async function jsm(): Promise<JetStreamManager> {
  return jetstreamManager(await connection());
}

export async function closeConnection(): Promise<void> {
  const pending = globalThis.__guardrailNats;
  if (pending === undefined) return;
  globalThis.__guardrailNats = undefined;
  await (await pending).drain();
}

export const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

export const decode = <T>(data: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(data)) as T;
