/**
 * SOT: registry-barrel, registry-index
 * WHAT   One import path for the registry.
 * WHY    One place for a person or an agent to look, and one place that says what the
 *        platform's vocabulary is.
 * NOTE   access.ts is deliberately not re-exported: it imports Better Auth's access module,
 *        and barrelling it drags that into every client bundle. Import `@guardrail/registry/access`.
 */
export * from "./define";
export * from "./derive";
export * from "./registry";
