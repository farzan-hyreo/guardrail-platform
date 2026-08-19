/**
 * SOT: errors, error-codes, wire-errors, upgrade-required
 * WHAT   The error vocabulary that survives a network hop.
 * WHY    A thrown Error does not cross a bus. Services return a coded reply; the gateway
 *        turns it back into a tRPC error with the structured data the UI needs.
 * HOW    Add a code to ERROR_CODES and the compiler demands a row in ERROR_HTTP_MAP.
 *        `ServiceError` carries the code across the handler boundary; the service half of
 *        the block turns it into a signed reject and the gateway maps it back.
 * NOTE   Reachable as `@guardrail/contracts/errors` as well as through the barrel, because
 *        the browser needs `isErrorCode` to narrow a denial and the barrel pulls in
 *        envelope.ts and signing.ts, which import `node:crypto`. Same reasoning as
 *        `@guardrail/registry/access`. This file must stay free of node imports.
 * WHERE  @guardrail/guardrail, packages/ui/src/components/denial.tsx
 * NOTE   biome.json turns style/useNamingConvention off for THIS FILE. ERROR_CODES and the
 *        keys of ERROR_HTTP_MAP are the wire vocabulary itself - they cross a network and
 *        appear in a browser as `error.data.app.code`. Renaming them to camelCase would
 *        rename the protocol. biome.json takes no comments, so the reason lives here.
 */
import { z } from "zod";

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "PERMISSION_DENIED",
  "UPGRADE_REQUIRED",
  "NO_ACTIVE_ORG",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_INPUT",
  "SERVICE_UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "UNTRUSTED_ENVELOPE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Fields are declared and assigned rather than written as constructor parameter properties:
 * `erasableSyntaxOnly` is on, and a parameter property is TypeScript that has to be emitted
 * rather than erased.
 */
export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly data: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.data = data;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return ERROR_CODES.some((code) => code === value);
}

/**
 * The refusal as it reaches the browser, on `error.data.app`.
 *
 * This is a wire shape, so it belongs here rather than being re-derived by hand at each
 * end. The gateway builds it in `errorFormatter` and a component parses it with this
 * schema; before, the producer emitted `Record<string, unknown>` and the consumer narrowed
 * with `typeof`/`in` checks, so the two agreed only by convention and neither end would
 * have failed to compile if the other changed.
 *
 * `.loose()` because the arms of `GatewayFailure` carry different extra fields and a strict
 * object would refuse the ones this schema does not name. `decision` stays `unknown`: it is
 * the registry's `AccessDecision`, and packages/contracts must not depend on the shape of a
 * plan decision to describe an error.
 */
export const denial = z
  .object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** RATE_LIMITED only. */
    retryAfterSeconds: z.number().optional(),
    /** PERMISSION_DENIED only. */
    permission: z.string().optional(),
    /** UPGRADE_REQUIRED only. */
    decision: z.unknown().optional(),
  })
  .loose();

export type Denial = z.infer<typeof denial>;

/** How each wire code surfaces in HTTP/tRPC. One table, no per-endpoint decisions. */
export const ERROR_HTTP_MAP: Readonly<Record<ErrorCode, string>> = {
  UNAUTHORIZED: "UNAUTHORIZED",
  PERMISSION_DENIED: "FORBIDDEN",
  UPGRADE_REQUIRED: "FORBIDDEN",
  NO_ACTIVE_ORG: "FORBIDDEN",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INVALID_INPUT: "BAD_REQUEST",
  SERVICE_UNAVAILABLE: "INTERNAL_SERVER_ERROR",
  DEADLINE_EXCEEDED: "TIMEOUT",
  UNTRUSTED_ENVELOPE: "FORBIDDEN",
  INTERNAL: "INTERNAL_SERVER_ERROR",
};
