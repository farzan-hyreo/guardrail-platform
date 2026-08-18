/**
 * SOT: gateway, gateway-block, the-block, dispatch, authorisation, org-scoping, plan-gate
 * WHAT   The half of the block that runs at the edge. Everything a request must survive
 *        before it is allowed onto the bus.
 * WHY    Authorisation belongs where identity lives - the gateway holds the session cookie,
 *        services never see it. The gateway decides, signs the decision into the envelope,
 *        and services enforce what was decided rather than deciding again.
 * HOW    Steps are numbered. A gateway route is one line because all of this is here.
 *        Step 7 signs the payload as well as the meta, and step 9 refuses a reply that is
 *        not signed by the same secret or does not name this request.
 * WHERE  apps/web/src/gateway/procedures.ts
 */
import "server-only";

import {
  contractFor,
  type Envelope,
  ERROR_HTTP_MAP,
  type ErrorCode,
  type InputOf,
  type OutputOf,
  type ReplyEnvelope,
  type RequestMeta,
  ServiceError,
  signRequest,
  verifyReply,
} from "@guardrail/contracts";
import {
  can,
  checkResourceAccess,
  commandSubject,
  type Entitlements,
  type OperationOf,
  type OrgRole,
  permissionsForRole,
  RESOURCES,
  type ResourceKey,
  roleAtLeast,
  rpcSubject,
  ruleFor,
} from "@guardrail/registry";
import { publishCommand, rpcRequest } from "@guardrail/transport";

import { refusedRole } from "./escalation";

export type GatewayIdentity = {
  readonly userId: string;
  readonly orgId: string;
  readonly role: OrgRole;
};

export type RateVerdict = { readonly ok: boolean; readonly retryAfterSeconds: number };

export type GatewayDeps = {
  /** Resolves the session. Swapping auth providers means changing only this function. */
  identify: (headers: Headers) => Promise<GatewayIdentity | null>;
  /** Plan and usage for the org. Cached at the edge; see apps/web/src/gateway/deps.ts. */
  entitlements: (orgId: string) => Promise<Entitlements>;
  rateLimit: (args: { key: string; max: number; windowSeconds: number }) => Promise<RateVerdict>;
  readonly secret: string;
};

export type GatewayFailure =
  | {
      readonly code: Exclude<ErrorCode, "UPGRADE_REQUIRED" | "RATE_LIMITED" | "PERMISSION_DENIED">;
      readonly message: string;
    }
  | { readonly code: "PERMISSION_DENIED"; readonly message: string; readonly permission: string }
  | { readonly code: "RATE_LIMITED"; readonly message: string; readonly retryAfterSeconds: number }
  | { readonly code: "UPGRADE_REQUIRED"; readonly message: string; readonly decision: unknown };

/**
 * `failure` is declared and assigned rather than written as a constructor parameter
 * property: `erasableSyntaxOnly` is on, and a parameter property is TypeScript that has to
 * be emitted rather than erased.
 */
export class GatewayError extends Error {
  readonly failure: GatewayFailure;

  constructor(failure: GatewayFailure) {
    super(failure.message);
    this.name = "GatewayError";
    this.failure = failure;
  }

  get trpcCode(): string {
    return ERROR_HTTP_MAP[this.failure.code];
  }
}

/**
 * Explicitly annotated so TypeScript narrows control flow after each call. That is what
 * removes every non-null assertion below - the compiler knows the request stopped here.
 */
const fail: (failure: GatewayFailure) => never = (failure) => {
  throw new GatewayError(failure);
};

export type DispatchArgs<K extends ResourceKey, O extends OperationOf<K>> = {
  readonly deps: GatewayDeps;
  readonly headers: Headers;
  readonly requestId: string;
  readonly ip: string;
  readonly resource: K;
  readonly operation: O;
  readonly input: unknown;
};

/**
 * The return type is the contract's output and nothing else. A command's contract already
 * declares the acceptance shape - member.create's output is `{accepted: true, requestId}` -
 * so widening every caller to a union just to describe the command branch made `.items`
 * unreachable on a query result three components deep in the UI.
 */
export async function dispatch<K extends ResourceKey, O extends OperationOf<K>>(
  args: DispatchArgs<K, O>,
): Promise<OutputOf<K, O>> {
  const { deps, resource, operation } = args;
  const definition = RESOURCES[resource];
  const rule = ruleFor(resource, operation);
  const permission = `${resource}:${String(operation)}`;

  // 1. Identity. The only place in the platform that reads a cookie.
  const identity = await deps.identify(args.headers);
  if (identity === null) fail({ code: "UNAUTHORIZED", message: "Sign in to continue." });

  // 2. Org scoping. From the session, never from input, and signed into the envelope so
  //    nothing downstream has to trust the caller for it.
  if (identity.orgId.length === 0) {
    fail({ code: "NO_ACTIVE_ORG", message: "Select an organisation to continue." });
  }

  // 3. Role gate.
  if (!roleAtLeast(identity.role, rule.minRole)) {
    fail({
      code: "PERMISSION_DENIED",
      message: `This action needs the ${rule.minRole} role.`,
      permission,
    });
  }

  // 4. Permission gate, derived from the registry rather than written by hand.
  const permissions = permissionsForRole(identity.role);
  if (!can(permissions, resource, operation)) {
    fail({
      code: "PERMISSION_DENIED",
      message: "You do not have permission to do that.",
      permission,
    });
  }

  // 4b. Privilege escalation. A role named in the body is a grant, and nobody may grant a
  //     role above their own. Derived from `assignableRoles`, so a role added to the
  //     registry is covered the moment it is declared - never compared by hand. Sits with
  //     the other authorisation gates, ahead of the rate limiter and the plan check.
  const refused = refusedRole(args.input, identity.role);
  if (refused !== null) {
    fail({
      code: "PERMISSION_DENIED",
      message: `Your ${identity.role} role cannot grant the ${refused} role.`,
      permission,
    });
  }

  // 5. Rate limit, keyed per org so one tenant cannot starve another.
  const verdict = await deps.rateLimit({
    key: `org:${identity.orgId}:${resource}:${String(operation)}`,
    max: definition.rateLimit.max,
    windowSeconds: definition.rateLimit.windowSeconds,
  });
  if (!verdict.ok) {
    fail({
      code: "RATE_LIMITED",
      message: "Too many requests. Try again shortly.",
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  }

  // 6. Entitlements, then the plan gate - the same pure function the browser uses.
  const entitlements = await deps.entitlements(identity.orgId);
  if (rule.consumes) {
    const decision = checkResourceAccess({ resource, entitlements });
    if (!decision.allowed) {
      fail({ code: "UPGRADE_REQUIRED", message: decision.upgradeMessage, decision });
    }
  }

  // 7. Build and sign. From here the decision travels with the request.
  const issuedAt = Date.now();
  const meta: RequestMeta = {
    requestId: args.requestId,
    orgId: identity.orgId,
    userId: identity.userId,
    role: identity.role,
    permissions: [...permissions],
    plan: entitlements.plan,
    resource,
    operation,
    issuedAt,
    deadlineAt: issuedAt + rule.timeoutMs,
  };
  const contract = contractFor(resource, operation);
  const payload: InputOf<K, O> = contract.input.parse(args.input);
  const envelope: Envelope<InputOf<K, O>> = {
    meta,
    payload,
    /** Over the payload as well as the meta, so the body cannot be swapped in flight. */
    signature: signRequest(meta, payload, deps.secret),
  };

  // 8. Dispatch. Commands are accepted durably; rpc waits for the service.
  if (rule.transport === "command") {
    await publishCommand({ subject: commandSubject(resource, operation), envelope });
    // Parsed through the same contract the service answers with, so the acceptance shape is
    // derived rather than asserted. A command whose contract declares something else fails
    // here, loudly, instead of handing the browser a shape it cannot use.
    return contract.output.parse({ accepted: true, requestId: meta.requestId });
  }

  let reply: ReplyEnvelope<unknown>;
  try {
    reply = await rpcRequest({
      subject: rpcSubject(resource, operation),
      envelope,
      timeoutMs: rule.timeoutMs,
    });
  } catch (error) {
    // A coded refusal from the transport - an unsigned or misaddressed reply - keeps its
    // code. Anything else is a timeout: say so plainly rather than leaking a transport error.
    if (error instanceof ServiceError) {
      return fail(toFailure({ code: error.code, message: error.message, data: error.data }));
    }
    return fail({
      code: "SERVICE_UNAVAILABLE",
      message: `The ${definition.owner} service did not respond. Try again shortly.`,
    });
  }

  // 9. Prove who answered. A queue group is not exclusivity: anything subscribed to the same
  //    subject can win the race, and a forged billing reply would sit in the entitlements
  //    cache for thirty seconds or hand an org owner an attacker's checkout URL. The
  //    request id is checked too, so a reply captured from one request cannot answer another.
  if (reply.requestId !== meta.requestId) {
    return fail({
      code: "UNTRUSTED_ENVELOPE",
      message: "The reply does not belong to this request.",
    });
  }
  const answered = reply.ok ? reply.data : reply.error;
  if (
    !verifyReply(
      /** Ours, not the reply's: the operation we asked for is the operation we accept. */
      {
        requestId: meta.requestId,
        resource: meta.resource,
        operation: meta.operation,
        ok: reply.ok,
      },
      answered,
      reply.signature,
      deps.secret,
    )
  ) {
    return fail({ code: "UNTRUSTED_ENVELOPE", message: "The reply signature is not valid." });
  }

  if (!reply.ok) {
    return fail(toFailure(reply.error));
  }

  // 10. Validate what came back. A service returning the wrong shape is a bug here, not a
  //     runtime surprise three components deep in the UI.
  return contract.output.parse(reply.data);
}

function toFailure(error: { code: string; message: string; data?: unknown }): GatewayFailure {
  switch (error.code) {
    case "UPGRADE_REQUIRED":
      return { code: "UPGRADE_REQUIRED", message: error.message, decision: error.data };
    case "PERMISSION_DENIED":
      return { code: "PERMISSION_DENIED", message: error.message, permission: "" };
    case "NOT_FOUND":
    case "CONFLICT":
    case "INVALID_INPUT":
    case "DEADLINE_EXCEEDED":
    case "UNTRUSTED_ENVELOPE":
    case "UNAUTHORIZED":
    case "NO_ACTIVE_ORG":
    case "SERVICE_UNAVAILABLE":
      return { code: error.code, message: error.message };
    default:
      return { code: "INTERNAL", message: error.message };
  }
}
