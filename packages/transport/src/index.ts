/**
 * SOT: transport-barrel, transport-index
 * WHAT   One import path for the bus: the connection, the streams, and the four verbs.
 * WHY    Swapping NATS for something else should touch this package and nothing above it.
 * HOW    Nothing outside this package builds a subject or opens a connection by hand.
 * WHERE  @guardrail/guardrail, services/<name>/src/index.ts, scripts
 */
export * from "./connection";
export * from "./request";
export * from "./serve";
export * from "./streams";
