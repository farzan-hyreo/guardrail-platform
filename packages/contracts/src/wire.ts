/**
 * SOT: wire-date, wire-primitives, json-round-trip, coerce-date
 * WHAT   The primitives that survive the codec, for fields whose JSON form is not their
 *        TypeScript form.
 * WHY    The bus codec is plain JSON. A `Date` leaves a service as an ISO string and
 *        arrives at the gateway as a string, so an output DTO declaring `z.date()` refused
 *        every reply that carried one - every list page in the product threw a ZodError for
 *        any organisation holding at least one row. The schema has to describe what is on
 *        the wire, not what the handler happened to hold.
 * HOW    `z.coerce.date()` accepts the ISO string the codec produces AND the Date the
 *        handler returns, so one schema validates the same value on both sides of the hop.
 *        The MAC is unaffected: `canonicalise` in envelope.ts maps a Date and its ISO
 *        string to the same bytes, which is why this is a schema change and not a wire
 *        break.
 * HOW    Declared here rather than written at each field, because "a date crosses the wire
 *        as a string" is one fact that six DTOs must never disagree about - the next DTO
 *        copies `wireDate` instead of copying `z.date()` and reintroducing the bug.
 * WHERE  packages/contracts/src/resources/*.contract.ts
 */
import { z } from "zod";

/**
 * A timestamp as it survives JSON. Accepts an ISO string or a Date and always yields a
 * Date, so a component renders `createdAt.toLocaleDateString()` whether the value came
 * straight from a handler or across the bus.
 */
export const wireDate = z.coerce.date();
