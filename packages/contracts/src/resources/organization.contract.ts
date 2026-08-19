/**
 * SOT: organization-contract, membership-contract, organization-wire
 * WHAT   Input and output schemas for every organisation and membership operation.
 * WHY    These operations used to be Better Auth HTTP endpoints with no schema either side
 *        of the wire. Gateway and service now parse the same schema, so neither can drift.
 * HOW    No `organizationId` appears in any input. The organisation a request acts on is
 *        `ctx.orgId` from the signed envelope - an id in an input here would be the whole
 *        multi-tenancy story undone, and `noOrgIdInInput` refuses it at the architecture
 *        check as well.
 * WHERE  services/identity
 */

import { z } from "zod";

import { wireDate } from "../wire";

/**
 * Lowercase, hyphen-separated, no leading or trailing hyphen. The column is unique, so a
 * slug that survives this still has to survive the insert; this only keeps a request that
 * could never be a URL from reaching the database at all.
 */
const slug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.");

export const organizationDto = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  createdAt: wireDate,
  /** How many people hold a seat. The Team page reads it without a second round trip. */
  memberCount: z.number().int(),
});

export const organizationContract = {
  read: { input: z.object({}), output: organizationDto },
  create: {
    input: z.object({ name: z.string().min(2).max(64), slug }),
    output: organizationDto,
  },
  update: {
    /**
     * Both optional, at least one present: `exactOptionalPropertyTypes` is on, so a handler
     * building the update object has to omit a key rather than pass `undefined`, and an
     * empty object would otherwise be a mutation that audits a change nobody made.
     */
    input: z
      .object({ name: z.string().min(2).max(64).optional(), slug: slug.optional() })
      .refine(
        (value) => value.name !== undefined || value.slug !== undefined,
        "Change the name, the slug, or both.",
      ),
    output: organizationDto,
  },
  delete: { input: z.object({}), output: z.object({ id: z.string() }) },
} as const;

export const membershipContract = {
  /**
   * Leaving takes no id: you can only leave the organisation the envelope names, as the
   * member the envelope names. There is no shape of this request that removes anybody else.
   */
  delete: { input: z.object({}), output: z.object({ id: z.string() }) },
} as const;
