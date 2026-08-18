/**
 * SOT: errors, error-codes, wire-errors, upgrade-required
 * WHAT   The error vocabulary that survives a network hop.
 * WHY    A thrown Error does not cross a bus. Services return a coded reply; the gateway
 *        turns it back into a tRPC error with the structured data the UI needs.
 * HOW    Add a code to ERROR_CODES and the compiler demands a row in ERROR_HTTP_MAP.
 *        `ServiceError` carries the code across the handler boundary; the service half of
 *        the block turns it into a signed reject and the gateway maps it back.
 * WHERE  @guardrail/guardrail, apps/web components
 */
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
