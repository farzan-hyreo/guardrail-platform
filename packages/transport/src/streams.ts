/**
 * SOT: streams, stream-bootstrap, jetstream-topology
 * WHAT   Creates or updates the streams the registry declares.
 * WHY    Topology as code. A service that assumed a stream existed and created its own
 *        with different retention is a Friday-night incident.
 * HOW    `pnpm nats:bootstrap` after `make up`, and in CI before integration tests.
 * WHERE  scripts/bootstrap-streams.ts
 * NOTE   biome.json turns style/useNamingConvention off for THIS FILE, for the same reason
 *        as serve.ts: these are JetStream's own snake_case config keys, sent verbatim.
 */
import "server-only";

import { STREAMS } from "@guardrail/registry";

import { jsm } from "./connection";

export async function ensureStreams(): Promise<string[]> {
  const manager = await jsm();
  const applied: string[] = [];

  for (const stream of STREAMS) {
    const config = {
      name: stream.name,
      subjects: [...stream.subjects],
      description: stream.description,
      max_age: stream.maxAgeDays * 24 * 60 * 60 * 1_000_000_000, // nanoseconds
      /** Dedupe window: a redelivered command with the same Nats-Msg-Id is dropped. */
      duplicate_window: 2 * 60 * 1_000_000_000,
    };
    try {
      await manager.streams.add(config);
      applied.push(`created ${stream.name}`);
    } catch {
      await manager.streams.update(stream.name, config);
      applied.push(`updated ${stream.name}`);
    }
  }
  return applied;
}
