/**
 * SOT: contract-wire-assertions, json-round-trip-test, wire-date-test
 * WHAT   Proves every contract schema describes what is on the wire, not what a handler
 *        happened to hold. Run with `pnpm tsx tests/contract-wire.test.ts`.
 * WHY    The bus codec is plain JSON, so a Date leaves a service as an ISO string. Six
 *        output DTOs declared `z.date()`, which refuses a string - every list page in the
 *        product threw a ZodError for any organisation holding at least one row, and
 *        nothing failed until a real row existed. A type error could not catch it: both
 *        sides typecheck, they simply disagree about what crossed the network.
 * HOW    Two checks, because either alone is escapable. The round trip pushes a real DTO
 *        through `JSON.parse(JSON.stringify(x))` - exactly what the codec does - and
 *        re-parses it, which catches today's bug. The structural sweep walks every input
 *        and output schema in the ContractMap and refuses a non-coerced date anywhere,
 *        which catches the NEXT DTO somebody writes with `z.date()`. The sweep counts the
 *        date leaves it visited, so a traversal that silently stops walking fails instead
 *        of passing vacuously.
 * WHERE  packages/contracts/src/wire.ts, packages/contracts/src/resources/*.contract.ts
 */
import assert from "node:assert/strict";

import type { z } from "zod";
import { contracts, memberDto, organizationDto, projectDto } from "../packages/contracts/src/index";

/* ── Reading a schema's shape ────────────────────────────────────────────── */

/**
 * Zod's own internals, narrowed once here.
 *
 * This is hand-narrowing of `unknown`, not the zod-parse boundary typescript-lockin rule 3
 * sanctions - there is no schema for "a zod schema", so there is nothing to parse it with.
 * It is confined to this test, it reads a structure rather than a wire payload, and nothing
 * in the running product depends on it. Do not copy the shape into src/.
 */
type SchemaDef = {
  readonly type: string;
  readonly coerce?: unknown;
  readonly shape?: unknown;
  readonly element?: unknown;
  readonly innerType?: unknown;
  readonly valueType?: unknown;
  readonly options?: unknown;
};

function defOf(schema: unknown): SchemaDef | null {
  if (typeof schema !== "object" || schema === null || !("_zod" in schema)) return null;
  const internals: unknown = schema._zod;
  if (typeof internals !== "object" || internals === null || !("def" in internals)) return null;
  const def: unknown = internals.def;
  if (typeof def !== "object" || def === null || !("type" in def)) return null;
  const type: unknown = def.type;
  return typeof type === "string" ? { ...def, type } : null;
}

type Child = { readonly key: string; readonly schema: unknown };

function childrenOf(def: SchemaDef): readonly Child[] {
  const out: Child[] = [];
  if (typeof def.shape === "object" && def.shape !== null) {
    for (const [key, schema] of Object.entries(def.shape)) out.push({ key, schema });
  }
  if (def.element !== undefined) out.push({ key: "[]", schema: def.element });
  if (def.innerType !== undefined) out.push({ key: "<inner>", schema: def.innerType });
  if (def.valueType !== undefined) out.push({ key: "<value>", schema: def.valueType });
  if (Array.isArray(def.options)) {
    for (const [index, schema] of def.options.entries()) {
      out.push({ key: `|${String(index)}`, schema });
    }
  }
  return out;
}

type DateLeaf = { readonly path: string; readonly coerced: boolean };

function findDates(schema: unknown, path: string, found: DateLeaf[]): void {
  const def = defOf(schema);
  if (def === null) return;
  if (def.type === "date") found.push({ path, coerced: def.coerce === true });
  for (const child of childrenOf(def)) {
    findDates(child.schema, `${path}.${child.key}`, found);
  }
}

/* ── The checks ──────────────────────────────────────────────────────────── */

/** What the codec actually does to a reply body between the service and the gateway. */
function throughTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

type Check = { name: string; run: () => void };

const dateLeaves: DateLeaf[] = [];
for (const [resource, operations] of Object.entries(contracts)) {
  for (const [operation, contract] of Object.entries(operations)) {
    findDates(contract.input, `${resource}.${operation}.input`, dateLeaves);
    findDates(contract.output, `${resource}.${operation}.output`, dateLeaves);
  }
}

const checks: Check[] = [
  {
    name: "every date in every contract is coerced (accepts the ISO string the codec sends)",
    run: () => {
      const plain = dateLeaves.filter((leaf) => !leaf.coerced).map((leaf) => leaf.path);
      assert.deepEqual(
        plain,
        [],
        `These fields declare z.date() and will refuse the string that actually arrives. Use wireDate from @guardrail/contracts:\n  ${plain.join("\n  ")}`,
      );
    },
  },
  {
    name: "the sweep actually walked the schemas (a traversal that stops finds nothing)",
    run: () => {
      // organization.read/create/update each return organizationDto, project.read/create/
      // update return projectDto, member.read/update return memberDto, and invitation.read
      // and auditLog.read carry one each. A traversal that quietly stops descending would
      // report zero and pass the check above without having proved anything.
      assert.ok(
        dateLeaves.length >= 6,
        `Expected the sweep to reach at least 6 date fields, reached ${dateLeaves.length}. The traversal in childrenOf() has stopped following a schema type it does not recognise.`,
      );
    },
  },
  {
    name: "projectDto survives the codec (archivedAt null and set)",
    run: () => {
      const row = {
        id: "p_1",
        name: "Apollo",
        slug: "apollo",
        description: null,
        archivedAt: null,
        createdAt: new Date("2026-08-19T10:00:00.000Z"),
      };
      const parsed = projectDto.parse(throughTheWire(row));
      assert.ok(parsed.createdAt instanceof Date);
      assert.equal(parsed.createdAt.toISOString(), "2026-08-19T10:00:00.000Z");
      assert.equal(parsed.archivedAt, null);

      const archived = projectDto.parse(
        throughTheWire({ ...row, archivedAt: new Date("2026-08-18T09:00:00.000Z") }),
      );
      assert.ok(archived.archivedAt instanceof Date);
    },
  },
  {
    name: "memberDto survives the codec",
    run: () => {
      const parsed = memberDto.parse(
        throughTheWire({
          id: "m_1",
          userId: "u_1",
          name: "Ada",
          email: "ada@example.com",
          role: "owner",
          createdAt: new Date("2026-08-19T10:00:00.000Z"),
        }),
      );
      assert.ok(parsed.createdAt instanceof Date);
    },
  },
  {
    name: "organizationDto survives the codec",
    run: () => {
      const parsed = organizationDto.parse(
        throughTheWire({
          id: "o_1",
          name: "Acme",
          slug: "acme",
          logo: null,
          createdAt: new Date("2026-08-19T10:00:00.000Z"),
          memberCount: 3,
        }),
      );
      assert.ok(parsed.createdAt instanceof Date);
    },
  },
  {
    name: "auditLog.read output survives the codec",
    run: () => {
      const schema: z.ZodType = contracts.auditLog.read.output;
      schema.parse(
        throughTheWire({
          items: [
            {
              id: "a_1",
              resource: "project",
              operation: "create",
              actorId: "u_1",
              actorRole: "owner",
              outcome: "success",
              createdAt: new Date("2026-08-19T10:00:00.000Z"),
            },
          ],
        }),
      );
    },
  },
];

let failures = 0;
for (const check of checks) {
  try {
    check.run();
    console.log(`PASS  ${check.name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${check.name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${checks.length - failures}/${checks.length} passed`);
if (failures > 0) process.exit(1);
