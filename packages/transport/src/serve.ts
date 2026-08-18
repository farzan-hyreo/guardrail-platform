/**
 * SOT: serve-rpc, consumer, queue-group, service-runtime, pull-consumer
 * WHAT   The two ways a service receives work: rpc subscriptions and durable consumers.
 * WHY    Queue groups give you horizontal scale for free - start a second replica and the
 *        work splits. Durable consumers give you at-least-once for commands.
 * WHERE  services/*/src/index.ts
 */
import "server-only";

import { AckPolicy } from "@nats-io/jetstream";

import { connection, decode, encode, js, jsm } from "./connection";

export type RpcHandler = (raw: unknown) => Promise<unknown>;

/** Subscribe to an rpc subject in a queue group. Returns an unsubscribe function. */
export async function serveRpc(args: {
  subject: string;
  queue: string;
  handler: RpcHandler;
}): Promise<() => void> {
  const nc = await connection();
  const subscription = nc.subscribe(args.subject, {
    queue: args.queue,
    callback: (error, message) => {
      if (error) {
        console.error(`[rpc] ${args.subject}`, error);
        return;
      }
      void (async () => {
        const reply = await args.handler(decode(message.data));
        message.respond(encode(reply));
      })();
    },
  });
  return () => subscription.unsubscribe();
}

/**
 * Durable consumer for commands and events. The handler must be idempotent: at-least-once
 * means it will occasionally see the same message twice.
 */
export async function consume(args: {
  stream: string;
  durable: string;
  filterSubject: string;
  handler: (raw: unknown, subject: string) => Promise<void>;
}): Promise<void> {
  const manager = await jsm();
  const config = {
    durable_name: args.durable,
    filter_subject: args.filterSubject,
    ack_policy: AckPolicy.Explicit,
    max_deliver: 5,
    ack_wait: 30 * 1_000_000_000,
  };
  try {
    await manager.consumers.add(args.stream, config);
  } catch {
    // Already exists with this config.
  }

  const stream = await js();
  const consumer = await stream.consumers.get(args.stream, args.durable);
  const messages = await consumer.consume();

  for await (const message of messages) {
    try {
      await args.handler(decode(message.data), message.subject);
      message.ack();
    } catch (error) {
      console.error(`[consume] ${args.durable} ${message.subject}`, error);
      // Redeliver with backoff; after max_deliver it lands on the stream's dead letter.
      message.nak(2000);
    }
  }
}
