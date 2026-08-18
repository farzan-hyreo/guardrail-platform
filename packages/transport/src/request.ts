/**
 * SOT: rpc-request, request-reply, dispatch, publish-command, publish-event
 * WHAT   The three ways a message leaves a process.
 * WHY    Every call site uses these, so retries, timeouts, dedupe ids and error decoding
 *        are decided once instead of per feature.
 * WHERE  @guardrail/guardrail (gateway), services/*
 */
import "server-only";

import type { Envelope, ReplyEnvelope } from "@guardrail/contracts";

import { connection, decode, encode, js } from "./connection";

/** Synchronous call. Rejects on timeout so the gateway can map it to a clean error. */
export async function rpcRequest<TReply>(args: {
  subject: string;
  envelope: Envelope;
  timeoutMs: number;
}): Promise<ReplyEnvelope<TReply>> {
  const nc = await connection();
  const message = await nc.request(args.subject, encode(args.envelope), {
    timeout: args.timeoutMs,
  });
  return decode<ReplyEnvelope<TReply>>(message.data);
}

/**
 * Durable command. `msgID` is the request id, so a retried publish is deduped by the
 * server inside the stream's duplicate window rather than running twice.
 */
export async function publishCommand(args: { subject: string; envelope: Envelope }): Promise<void> {
  const stream = await js();
  await stream.publish(args.subject, encode(args.envelope), {
    msgID: args.envelope.meta.requestId,
  });
}

/** A fact that already happened. Fire and forget, but durable. */
export async function publishEvent(args: {
  subject: string;
  envelope: Envelope;
}): Promise<void> {
  const stream = await js();
  await stream.publish(args.subject, encode(args.envelope), {
    msgID: `${args.envelope.meta.requestId}:evt`,
  });
}
