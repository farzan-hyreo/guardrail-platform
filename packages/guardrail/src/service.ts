/**
 * SOT: service-guard, define-service, define-consumer, handler-for, service-block,
 *      envelope-verification, subject-binding, idempotency
 * WHAT   The half of the block that runs inside a service.
 * WHY    A service must never trust the wire. Verification, subject binding, freshness, org
 *        scoping, input parsing, output validation, event emission and error mapping are
 *        wired here, so a handler is a pure function of (ctx, input) and cannot skip a check.
 * HOW    Handlers are a flat list built with `handlerFor`, which infers input and output
 *        from the contract. Subjects are never built from a template literal: each handler
 *        is matched against the registry's own `ROUTES`, which is also what proves at boot
 *        that this service is allowed to answer for the resource at all.
 * WHERE  services/<name>/src/*.handlers.ts, services/<name>/src/index.ts
 */
import "server-only";

import {
  checkFreshness,
  contractFor,
  type EventPayload,
  envelope as envelopeSchema,
  eventPayload as eventPayloadSchema,
  type InputOf,
  type OutputOf,
  type ReplyBinding,
  type ReplyEnvelope,
  type RequestMeta,
  ServiceError,
  signEvent,
  signReply,
  type Transport,
  verifyEvent,
  verifyRequest,
} from "@guardrail/contracts";
import {
  type Operation,
  type OperationOf,
  type ResourceKey,
  ROUTES,
  type ServiceName,
} from "@guardrail/registry";
import { publishEvent } from "@guardrail/transport";

import { refusedRole } from "./escalation";

/** What a handler receives. There is no way to widen it beyond one organisation. */
export type ServiceContext = {
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly role: RequestMeta["role"];
  readonly plan: RequestMeta["plan"];
  readonly deadlineAt: number;
};

/**
 * A handler after registration. `unknown` here is honest: `execute` sits at the wire
 * boundary and narrows by parsing in the same function, which is the only place `unknown`
 * is allowed in this codebase.
 */
export type HandlerEntry = {
  readonly resource: ResourceKey;
  readonly operation: Operation;
  execute(ctx: ServiceContext, raw: unknown): Promise<unknown>;
};

/** Input and output are inferred from the contract - never annotated by the caller. */
export function handlerFor<K extends ResourceKey, O extends OperationOf<K>>(
  resource: K,
  operation: O,
  run: (args: { ctx: ServiceContext; input: InputOf<K, O> }) => Promise<OutputOf<K, O>>,
): HandlerEntry {
  const contract = contractFor(resource, operation);
  return {
    resource,
    operation,
    async execute(ctx, raw) {
      const parsed = contract.input.safeParse(raw);
      if (!parsed.success) {
        throw new ServiceError(
          "INVALID_INPUT",
          "Input does not match the contract.",
          parsed.error.flatten(),
        );
      }
      const output = await run({ ctx, input: parsed.data });
      return contract.output.parse(output);
    },
  };
}

export type ServiceRoute = {
  readonly resource: ResourceKey;
  readonly operation: Operation;
  readonly subject: string;
  readonly transport: Transport;
  /** The evt subject this operation emits on, or null when the registry does not audit it. */
  readonly event: string | null;
};

export type ServiceRuntime = {
  readonly service: ServiceName;
  readonly routes: readonly ServiceRoute[];
  /**
   * `subject` is the subject the message actually arrived on. Without it a valid rpc
   * envelope published onto the CMD stream becomes a durable command, and the intent the
   * gateway signed is not the intent that runs.
   */
  handle(rawEnvelope: unknown, subject: string): Promise<ReplyEnvelope<unknown>>;
  /** Pre-signed refusal for bytes the transport could not turn into a reply at all. */
  readonly unreadable: ReplyEnvelope<never>;
};

type Binding = { readonly route: ServiceRoute; readonly entry: HandlerEntry };

/** Everything a reply is bound to except its outcome, which `reject` and the success path
 * each know for themselves. `RequestMeta` satisfies it structurally, so a refusal that has
 * a verified meta simply hands it over. */
type ReplyRoute = Omit<ReplyBinding, "ok">;

/**
 * The two refusals that happen before any meta can be trusted: bytes that are not an envelope
 * at all, and the pre-signed `unreadable`. Neither can name an operation, and neither needs
 * to - both verifiers compare the request id BEFORE they check the signature, and "unknown"
 * matches no request, so these are refused for answering the wrong request and never reach
 * the reply MAC at all.
 */
const UNROUTED: ReplyRoute = {
  requestId: "unknown",
  resource: "unknown",
  operation: "unknown",
};

export function defineService(
  service: ServiceName,
  handlers: readonly HandlerEntry[],
  options: { secret: string },
): ServiceRuntime {
  /**
   * Boot-time wiring, from the registry's own route table rather than from a template
   * literal built here. Two mistakes fail on `make dev` instead of at 3am: an operation no
   * resource declares, and a service answering for a resource the registry gives to
   * somebody else.
   */
  const bindings: readonly Binding[] = handlers.map((entry) => {
    const route = ROUTES.find(
      (candidate) =>
        candidate.resource === entry.resource && candidate.operation === entry.operation,
    );
    if (route === undefined) {
      throw new Error(
        `Service '${service}' handles '${entry.resource}.${entry.operation}', which the registry does not declare. There is no subject for it.`,
      );
    }
    if (route.owner !== service) {
      throw new Error(
        `Service '${service}' handles '${entry.resource}', which the registry says '${route.owner}' owns.`,
      );
    }
    return {
      entry,
      route: {
        resource: route.resource,
        operation: route.operation,
        subject: route.subject,
        transport: route.transport,
        event: route.event,
      },
    };
  });

  const routes: readonly ServiceRoute[] = bindings.map((binding) => binding.route);

  function reject(
    route: ReplyRoute,
    code: string,
    message: string,
    data?: unknown,
  ): ReplyEnvelope<never> {
    const error = data === undefined ? { code, message } : { code, message, data };
    return {
      ok: false,
      requestId: route.requestId,
      signature: signReply({ ...route, ok: false }, error, options.secret),
      error,
    };
  }

  /**
   * Gates 5 and 5b: everything the envelope claims about its caller, re-checked here
   * rather than taken on the gateway's word. Kept together and out of `handle` so the
   * block still reads as a flat list of refusals, and so neither can be reordered away
   * from the other.
   */
  function reassertAuthority(meta: RequestMeta, payload: unknown): ReplyEnvelope<never> | null {
    // 5. Re-assert the permission the gateway claims to have checked. Cheap, and it means
    //    a gateway bug cannot become a data breach.
    if (!meta.permissions.includes(`${meta.resource}:${meta.operation}`)) {
      return reject(meta, "PERMISSION_DENIED", "Envelope does not carry this permission.");
    }

    // 5b. Privilege escalation, the mirror of gateway 4b. `meta.role` is the caller's own
    //     role, signed; the body beside it is whatever arrived. The gateway deciding this
    //     correctly is not enough - a gate that only ever runs at the edge means one
    //     gateway bug is an escalation, which is the reason the block is split at all.
    const refused = refusedRole(payload, meta.role);
    if (refused !== null) {
      return reject(
        meta,
        "PERMISSION_DENIED",
        `Your ${meta.role} role cannot grant the ${refused} role.`,
      );
    }

    return null;
  }

  const unreadable = reject(
    UNROUTED,
    "UNTRUSTED_ENVELOPE",
    "The service could not read this message.",
  );

  async function handle(rawEnvelope: unknown, subject: string): Promise<ReplyEnvelope<unknown>> {
    const parsed = envelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return reject(UNROUTED, "UNTRUSTED_ENVELOPE", "Malformed envelope.");
    }
    const { meta, payload, signature } = parsed.data;

    // 1. Signature, over the meta and the body together. Over the meta alone, orgId is
    //    authorised but the payload beside it is whatever the last publisher swapped in.
    if (!verifyRequest(meta, payload, signature, options.secret)) {
      return reject(meta, "UNTRUSTED_ENVELOPE", "Envelope signature is not valid.");
    }

    // 2. Route. meta.resource and meta.operation are already narrowed by the schema.
    const binding = bindings.find(
      (candidate) =>
        candidate.route.resource === meta.resource && candidate.route.operation === meta.operation,
    );
    if (binding === undefined) {
      return reject(meta, "NOT_FOUND", `No handler for ${meta.resource}.${meta.operation}.`);
    }

    // 3. Subject. The signed intent names one transport; this is where it arrived. A valid
    //    rpc envelope replayed onto the CMD stream would otherwise become durable.
    if (subject !== binding.route.subject) {
      return reject(
        meta,
        "UNTRUSTED_ENVELOPE",
        `Envelope for ${binding.route.subject} arrived on ${subject}.`,
      );
    }

    // 4. Freshness. The deadline applies to rpc only; a command is durable by design.
    const freshness = checkFreshness(meta, binding.route.transport);
    if (!freshness.fresh) {
      return reject(meta, freshness.code, freshness.message);
    }

    const refusal = reassertAuthority(meta, payload);
    if (refusal !== null) return refusal;

    const ctx: ServiceContext = {
      requestId: meta.requestId,
      orgId: meta.orgId,
      userId: meta.userId,
      role: meta.role,
      plan: meta.plan,
      deadlineAt: meta.deadlineAt,
    };

    try {
      const data = await binding.entry.execute(ctx, payload);

      // 6. Emit the fact. Audit and metering are consumers, not code in the request path,
      //    so a slow audit write can never slow a customer's request. The event is signed
      //    over its own body: the request signature covers the request's payload, and
      //    reusing it here would hand every consumer a signature that verifies nothing.
      if (binding.route.event !== null) {
        const event: EventPayload = { outcome: "success" };
        await publishEvent({
          subject: binding.route.event,
          envelope: { meta, payload: event, signature: signEvent(meta, event, options.secret) },
        });
      }

      return {
        ok: true,
        requestId: meta.requestId,
        signature: signReply(
          {
            requestId: meta.requestId,
            resource: meta.resource,
            operation: meta.operation,
            ok: true,
          },
          data,
          options.secret,
        ),
        data,
      };
    } catch (error) {
      if (error instanceof ServiceError) {
        return reject(meta, error.code, error.message, error.data);
      }
      console.error(`[${service}] ${meta.resource}.${meta.operation}`, error);
      return reject(meta, "INTERNAL", "The service failed to handle this request.");
    }
  }

  return { service, routes, handle, unreadable };
}

/**
 * The consumer half of the block. An evt.* consumer that only checks the shape of an
 * envelope trusts `meta.orgId` from whoever published it: forged events meter a victim org
 * without limit, and because `audit_log.requestId` is unique with `onConflictDoNothing`, a
 * forged event racing a real one silently suppresses the genuine audit row.
 *
 * A message that fails any check here is dropped rather than thrown, so JetStream acks it
 * instead of redelivering forged bytes five times.
 */
export function defineConsumer(
  options: { secret: string },
  run: (args: { meta: RequestMeta; payload: EventPayload; subject: string }) => Promise<void>,
): (raw: unknown, subject: string) => Promise<void> {
  return async (raw, subject) => {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[consumer] dropped a malformed envelope on ${subject}`);
      return;
    }
    const { meta, payload, signature } = parsed.data;

    if (!verifyEvent(meta, payload, signature, options.secret)) {
      console.error(
        `[consumer] dropped an unsigned ${meta.resource}.${meta.operation} on ${subject}`,
      );
      return;
    }

    const body = eventPayloadSchema.safeParse(payload);
    if (!body.success) {
      console.error(`[consumer] dropped ${meta.resource}.${meta.operation}: not an event body`);
      return;
    }

    const route = ROUTES.find(
      (candidate) => candidate.resource === meta.resource && candidate.operation === meta.operation,
    );
    if (route === undefined || route.event !== subject) {
      console.error(
        `[consumer] dropped ${meta.resource}.${meta.operation} delivered on ${subject}`,
      );
      return;
    }

    await run({ meta, payload: body.data, subject });
  };
}
