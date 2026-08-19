/**
 * SOT: project-contract, project-schemas, project-wire
 * WHAT   Input and output schemas for every project operation.
 * WHY    Gateway and service parse the same schema. Neither can drift, and neither needs
 *        documentation to know the shape.
 * HOW    Add a field to the schema and both halves see it. No org id appears anywhere in
 *        this file, in an input or an output: the caller is already scoped to exactly one
 *        organisation by the signed envelope, so echoing it back is a field nobody reads
 *        and a shape the architecture check has to treat as a leak.
 * WHERE  packages/contracts/src/index.ts, services/projects
 */
import { z } from "zod";

import { wireDate } from "../wire";

export const projectDto = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  archivedAt: wireDate.nullable(),
  createdAt: wireDate,
});

export const projectContract = {
  read: {
    input: z.object({
      cursor: z.string().nullish(),
      limit: z.number().int().min(1).max(100).default(20),
      includeArchived: z.boolean().default(false),
    }),
    output: z.object({ items: z.array(projectDto), nextCursor: z.string().nullable() }),
  },
  create: {
    input: z.object({
      name: z.string().min(2).max(80),
      slug: z
        .string()
        .min(2)
        .max(48)
        .regex(/^[a-z0-9-]+$/, "Lowercase, numbers and hyphens only."),
      description: z.string().max(500).optional(),
    }),
    output: projectDto,
  },
  update: {
    input: z.object({
      id: z.string(),
      name: z.string().min(2).max(80).optional(),
      description: z.string().max(500).nullable().optional(),
      archived: z.boolean().optional(),
    }),
    output: projectDto,
  },
  delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
  },
} as const;
