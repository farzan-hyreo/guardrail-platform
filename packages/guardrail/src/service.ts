/**
 * SOT: service-guard, define-service, handler-for, service-block, envelope-verification, idempotency
 * WHAT   The half of the block that runs inside a service.
 * WHY    A service must never trust the wire. Verification, deadline, org scoping, input
 *        parsing, output validation, event emission and error mapping are wired here, so a
 *        handler is a pure function of (ctx, input) and cannot skip a check.
 * HOW    Handlers are a flat list built with `handlerFor`, which infers input and output
 *        from the contract. That shape is what lets this file be fully typed: there is no
 *        nested optional map to index into and therefore no cast.
 * WHERE  services/*​/src/*.handlers.ts
 */
import "server-only";

import {
  ServiceError,
  contractFor,
  envelope as envelopeSchema,
  isExpired,
  verifyMeta,
  type InputOf,
  type OutputOf,
  type ReplyEnvelope,
  type RequestMeta,
} from "@guardrail/contracts";
import {
  eventSubject,
  isOperationOf,
  resourcesOwnedBy,
  ruleFor,
  type Operation,
  type OperationOf,
  type ResourceKey,
  type ServiceName,
} from "@guardrail/registry";
import { publishEvent } from "@guardrail/transport";

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
        throw new ServiceError("INVALID_INPUT", "Input does not match the contract.", parsed.error.flatten());
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
  readonly transport: "rpc" | "command";
};

export type ServiceRuntime = {
  readonly service: ServiceName;
  readonly routes: readonly ServiceRoute[];
  handle(rawEnvelope: unknown): Promise<ReplyEnvelope<unknown>>;
};

export function defineService(
  service: ServiceName,
  handlers: readonly HandlerEntry[],
  options: { secret: string },
): ServiceRuntime {
  const owned = resourcesOwnedBy(service);

  // Boot-time assertion. A handler for another service's resource is a wiring mistake,
  // and it fails on `make dev` rather than at 3am.
  for (const entry of handlers) {
    if (!owned.includes(entry.resource)) {
      throw new Error(
        `Service '${service}' handles '${entry.resource}', which the registry says another service owns.`,
      );
    }
  }

  const routes: readonly ServiceRoute[] = handlers.map((entry) => {
    if (!isOperationOf(entry.resource, entry.operation)) {
      throw new Error(`Undeclared operation ${entry.operation} on ${entry.resource}.`);
    }
    const rule = ruleFor(entry.resource, entry.operation);
    return {
      resource: entry.resource,
      operation: entry.operation,
      transport: rule.transport,
      subject:
        rule.transport === "rpc"
          ? `rpc.${entry.resource}.${entry.operation}`
          : `cmd.${entry.resource}.${entry.operation}`,
    };
  });

  async function handle(rawEnvelope: unknown): Promise<ReplyEnvelope<unknown>> {
    const parsed = envelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return reject("unknown", "UNTRUSTED_ENVELOPE", "Malformed envelope.");
    }
    const { meta, payload, signature } = parsed.data;

    // 1. Signature. Without it, orgId is a claim from whoever published.
    if (!verifyMeta(meta, signature, options.secret)) {
      return reject(meta.requestId, "UNTRUSTED_ENVELOPE", "Envelope signature is not valid.");
    }

    // 2. Deadline. Nobody is waiting; do not spend a query on it.
    if (isExpired(meta)) {
      return reject(meta.requestId, "DEADLINE_EXCEEDED", "Request expired before it was handled.");
    }

    // 3. Route. meta.resource and meta.operation are already narrowed by the schema.
    const entry = handlers.find(
      (candidate) => candidate.resource === meta.resource && candidate.operation === meta.operation,
    );
    if (entry === undefined) {
      return reject(meta.requestId, "NOT_FOUND", `No handler for ${meta.resource}.${meta.operation}.`);
    }

    // 4. Re-assert the permission the gateway claims to have checked. Cheap, and it means
    //    a gateway bug cannot become a data breach.
    if (!meta.permissions.includes(`${meta.resource}:${meta.operation}`)) {
      return reject(meta.requestId, "PERMISSION_DENIED", "Envelope does not carry this permission.");
    }

    const ctx: ServiceContext = {
      requestId: meta.requestId,
      orgId: meta.orgId,
      userId: meta.userId,
      role: meta.role,
      plan: meta.plan,
      deadlineAt: meta.deadlineAt,
    };

    try {
      const data = await entry.execute(ctx, payload);

      // 5. Emit the fact. Audit and metering are consumers, not code in the request path,
      //    so a slow audit write can never slow a customer's request.
      if (isOperationOf(meta.resource, meta.operation) && ruleFor(meta.resource, meta.operation).audit) {
        await publishEvent({
          subject: eventSubject(meta.resource, meta.operation),
          envelope: { meta, payload: { outcome: "success" }, signature },
        });
      }

      return { ok: true, requestId: meta.requestId, data };
    } catch (error) {
      if (error instanceof ServiceError) {
        return reject(meta.requestId, error.code, error.message, error.data);
      }
      console.error(`[${service}] ${meta.resource}.${meta.operation}`, error);
      return reject(meta.requestId, "INTERNAL", "The service failed to handle this request.");
    }
  }

  return { service, routes, handle };
}

function reject(
  requestId: string,
  code: string,
  message: string,
  data?: unknown,
): ReplyEnvelope<never> {
  return data === undefined
    ? { ok: false, requestId, error: { code, message } }
    : { ok: false, requestId, error: { code, message, data } };
}
