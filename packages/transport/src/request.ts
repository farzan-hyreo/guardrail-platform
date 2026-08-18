/**
 * SOT: rpc-request, request-reply, dispatch, publish-command, publish-event, reply-validation
 * WHAT   The three ways a message leaves a process.
 * WHY    Every call site uses these, so retries, timeouts, dedupe ids, reply validation and
 *        error decoding are decided once instead of per feature.
 * HOW    A reply is parsed against `replyEnvelope` rather than cast into shape, then checked
 *        against the request it claims to answer and the shared secret. The bytes come off a
 *        subject anything can publish on: a queue group is not exclusivity, and
 *        `decode<ReplyEnvelope<T>>` was a promise nobody kept - a malformed answer reached
 *        `reply.error` and threw a TypeError out of the gateway as a raw 500.
 *        The check lives here as well as in the gateway block because not every caller goes
 *        through `dispatch`: the entitlements cache asks billing directly, and a forged
 *        answer there pins an organisation to the wrong plan for the life of the cache.
 * WHERE  @guardrail/guardrail (gateway), apps/web/src/gateway/deps.ts, services/<name>
 */
import "server-only";

import {
  type Envelope,
  type ReplyEnvelope,
  replyEnvelope,
  ServiceError,
  verifyReply,
} from "@guardrail/contracts";
import { env } from "@guardrail/env";
import { z } from "zod";

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

  const parsed = replyEnvelope.safeParse(decode(message.data));
  if (!parsed.success) {
    throw new ServiceError(
      "UNTRUSTED_ENVELOPE",
      `The reply on ${args.subject} is not a reply envelope.`,
    );
  }
  const reply = parsed.data;

  // Bound to the request it answers, so a reply captured from one call cannot answer another.
  if (reply.requestId !== args.envelope.meta.requestId) {
    throw new ServiceError(
      "UNTRUSTED_ENVELOPE",
      `The reply on ${args.subject} answers a different request.`,
    );
  }

  const answered = reply.ok ? reply.data : reply.error;
  if (
    !verifyReply(
      /** From the envelope we sent, never from the reply we are checking. */
      {
        requestId: args.envelope.meta.requestId,
        resource: args.envelope.meta.resource,
        operation: args.envelope.meta.operation,
        ok: reply.ok,
      },
      answered,
      reply.signature,
      env.envelopeSecret(),
    )
  ) {
    throw new ServiceError(
      "UNTRUSTED_ENVELOPE",
      `The reply on ${args.subject} is not signed by the owning service.`,
    );
  }

  if (!reply.ok) {
    return {
      ok: false,
      requestId: reply.requestId,
      signature: reply.signature,
      error: reply.error,
    };
  }

  /**
   * The envelope is validated; `data` deliberately is not. The transport does not know the
   * contract, so it carries the caller's expectation rather than checking it - the gateway
   * re-parses this with `contract.output.parse` before anything reads it, and the reply
   * signature has already proved which process produced it.
   */
  return {
    ok: true,
    requestId: reply.requestId,
    signature: reply.signature,
    data: z.custom<TReply>().parse(reply.data),
  };
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
export async function publishEvent(args: { subject: string; envelope: Envelope }): Promise<void> {
  const stream = await js();
  await stream.publish(args.subject, encode(args.envelope), {
    msgID: `${args.envelope.meta.requestId}:evt`,
  });
}
