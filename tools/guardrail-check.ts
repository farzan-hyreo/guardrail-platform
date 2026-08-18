/**
 * SOT: guardrail-check, architecture-check, boundary-check, cross-service-lint,
 *      consumer-verification-lint, auth-endpoint-supersession-lint
 * WHAT   The architecture rules Biome cannot express, checked in one fast pass over the
 *        TypeScript AST.
 * WHY    Biome's GritQL plugins match patterns inside a file. Some of these rules compare a
 *        file's own path to what it imports, and the rest need the *shape* of a subtree
 *        rather than a keyword: a keyword blacklist misses a ternary and a `.map()`, and a
 *        whole-file text search flags an output schema that was never an input. A rule you
 *        cannot express is a rule you do not have, so they live here, over the AST.
 * HOW    `pnpm guardrail` to check, `pnpm guardrail --fix` to repair what is repairable.
 *        Runs in `pnpm verify` and takes well under a second on this repo.
 * WHERE  package.json (verify), CI, tools/grit/no-raw-subjects.grit (the Biome half),
 *        biome.json (the noRestrictedImports half of the cross-service boundary)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type Finding = { file: string; line: number; rule: string; message: string };

const ROOT = process.cwd();
const fix = process.argv.includes("--fix");
const findings: Finding[] = [];
let repaired = 0;

const SKIP = new Set(["node_modules", ".next", ".turbo", "dist", "drizzle", ".git"]);

/**
 * tools/ and scripts/ are scanned as well. They are the only code in the repo that can
 * weaken a check, and a checker that exempts its own tooling ships with a documented
 * bypass. The single exclusion left is this file, which necessarily contains the very
 * patterns it searches for - see `noRawSubjects`.
 */
const SCANNED = ["apps", "packages", "services", "tools", "scripts"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function report(file: string, line: number, rule: string, message: string): void {
  findings.push({ file: relative(ROOT, file), line, rule, message });
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/* ── The AST ─────────────────────────────────────────────────────────────── */

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, kind);
}

function lineOfNode(tree: ts.SourceFile, node: ts.Node): number {
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

/** Every module specifier: import, export-from, import type, `import()`, require. */
function moduleSpecifiers(tree: ts.SourceFile): ts.StringLiteralLike[] {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      out.push(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const first = node.arguments[0];
      if ((dynamic || required) && first !== undefined && ts.isStringLiteralLike(first)) {
        out.push(first);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

/** Names this file imported. A router property may reference one; it may not invent one. */
function importedBindings(tree: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/** Top-level `const x = <expr>`, so a schema chain can be followed to its root in-file. */
function topLevelValues(tree: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const values = new Map<string, ts.Expression>();
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        values.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return values;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

/** Plain English for the message, so the reader is told what they wrote, not a node kind. */
function shapeOf(node: ts.Node): string {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "a function";
  if (ts.isConditionalExpression(node)) return "a ternary";
  if (ts.isBinaryExpression(node)) return "a compound expression";
  if (ts.isAwaitExpression(node)) return "an await";
  if (ts.isObjectLiteralExpression(node)) return "an object literal";
  if (ts.isPropertyAccessExpression(node)) return "a property access";
  if (ts.isCallExpression(node)) return "a call to something else";
  if (ts.isIdentifier(node)) return `the local value '${node.text}'`;
  return "not a gateway procedure";
}

/* ── The registry, at runtime ────────────────────────────────────────────── */

/**
 * The plan list is read from the registry instead of written here. Hardcoded, a fourth plan
 * hand-written into derive.ts - the exact violation `no-data-in-derive` exists to catch -
 * would not fire the rule that was meant to stop it.
 */
async function planKeysFromRegistry(): Promise<readonly string[]> {
  const entry = join(ROOT, "packages", "registry", "src", "registry.ts");
  const where = relative(ROOT, entry);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (typeof loaded !== "object" || loaded === null || !("PLANS" in loaded)) {
    throw new Error(`${where} does not export PLANS, so the plan rules cannot be derived.`);
  }
  const plans: unknown = loaded.PLANS;
  if (typeof plans !== "object" || plans === null) {
    throw new Error(`${where} exports a PLANS that is not an object.`);
  }
  const keys = Object.keys(plans).filter((key) => /^[A-Za-z0-9_$]+$/.test(key));
  if (keys.length === 0) throw new Error(`${where} declares no plans.`);
  return keys;
}

let planKeys: readonly string[] = [];
try {
  planKeys = await planKeysFromRegistry();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    `guardrail: could not read the registry, so no rule can be trusted.\n    ${detail}`,
  );
  process.exit(1);
}

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** Anything that reaches a database, a secret or the bus must never reach the browser. */
function requireServerOnly(file: string, source: string): string {
  const applies =
    /\.(service|adapter|handlers)\.ts$/.test(file) || /[/\\]src[/\\]db\.ts$/.test(file);
  if (!applies || source.includes('import "server-only"')) return source;
  if (fix) {
    repaired += 1;
    return `import "server-only";\n\n${source}`;
  }
  report(file, 1, "require-server-only", 'Missing `import "server-only";`.');
  return source;
}

/**
 * Services talk over subjects. An import is a shared deployment by another name - and it
 * hides in two shapes a `from "..."` scan never sees: `await import("../../identity/src/db")`
 * carries no `from` clause, and `@guardrail/service-identity` carries no `services/` segment,
 * so one line in a package.json would have removed the boundary silently.
 */
const SERVICE_PACKAGE = /^@guardrail\/service-([^"'/]+)/;
const SERVICE_PATH = /services[/\\]([^/\\]+)/;

function serviceTargetOf(file: string, specifier: string): string | undefined {
  const aliased = SERVICE_PACKAGE.exec(specifier)?.[1];
  if (aliased !== undefined) return aliased;
  // `../../identity/src/db` names no service until it is resolved against the importer.
  const where = specifier.startsWith(".") ? resolve(dirname(file), specifier) : specifier;
  return SERVICE_PATH.exec(where)?.[1];
}

function noCrossServiceImport(file: string, tree: ts.SourceFile): void {
  const own = SERVICE_PATH.exec(file)?.[1];
  if (own === undefined) return;
  for (const specifier of moduleSpecifiers(tree)) {
    const target = serviceTargetOf(file, specifier.text);
    if (target === undefined || target === own) continue;
    report(
      file,
      lineOfNode(tree, specifier),
      "no-cross-service-import",
      `Service '${own}' reaches service '${target}' through '${specifier.text}'. Delete the import and ask over a subject with request()/publish(), or share the type through @guardrail/contracts.`,
    );
  }
}

/**
 * A gateway route is a routing decision. This is a whitelist of shapes, not a blacklist of
 * keywords: a ternary, a `.map()`, an `&&`, a `??`, a `.then()` and a bare early return all
 * carry real logic while containing none of `if for while switch await try`.
 */
const GATEWAY_PROCEDURES = new Set(["gatewayQuery", "gatewayMutation"]);

function isGatewayRoute(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression)) return false;
  if (!GATEWAY_PROCEDURES.has(node.expression.text)) return false;
  return node.arguments.every((argument) => ts.isStringLiteral(argument));
}

function reportRoute(
  file: string,
  tree: ts.SourceFile,
  node: ts.Node,
  name: string,
  shape: string,
): void {
  report(
    file,
    lineOfNode(tree, node),
    "no-business-logic-in-gateway",
    `Route '${name}' is ${shape}. Every property of createTRPCRouter must be exactly gatewayQuery("resource", "operation"), gatewayMutation("resource", "operation"), or an imported router. Move everything else into the service that owns the resource.`,
  );
}

function checkRouterProperty(
  file: string,
  tree: ts.SourceFile,
  property: ts.ObjectLiteralElementLike,
  imported: ReadonlySet<string>,
): void {
  const name = propertyName(property) ?? "<property>";
  if (ts.isShorthandPropertyAssignment(property)) {
    if (!imported.has(property.name.text)) {
      reportRoute(file, tree, property, name, `the local value '${property.name.text}'`);
    }
    return;
  }
  if (!ts.isPropertyAssignment(property)) {
    reportRoute(file, tree, property, name, "a spread or a method, not a route");
    return;
  }
  const value = property.initializer;
  if (isGatewayRoute(value)) return;
  if (ts.isIdentifier(value) && imported.has(value.text)) return;
  reportRoute(file, tree, property, name, shapeOf(value));
}

function noBusinessLogicInGateway(file: string, tree: ts.SourceFile): void {
  if (!/gateway[/\\]routers[/\\]/.test(file)) return;
  const imported = importedBindings(tree);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createTRPCRouter"
    ) {
      const shape = node.arguments[0];
      if (shape === undefined || !ts.isObjectLiteralExpression(shape)) {
        report(
          file,
          lineOfNode(tree, node),
          "no-business-logic-in-gateway",
          "createTRPCRouter must be given an object literal of routes, so the whole API surface is readable in one screen. Write { name: gatewayQuery(...) } inline.",
        );
      } else {
        for (const property of shape.properties) {
          checkRouterProperty(file, tree, property, imported);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/**
 * The single highest-value check in this file. An org id accepted as input is a
 * cross-tenant leak waiting for its first agent-written endpoint - the gateway takes it
 * from the session and signs it, so no schema ever needs to ask for one.
 *
 * Scoped to the `input:` subtree, never the whole file: `projectDto.organizationId` is an
 * output, and flagging it made `pnpm verify` red on correct code, which is exactly how a
 * check gets loosened away.
 */
const ORG_ID_ALIAS = /^(?:org|organization|organisation|tenant)id$/;

function isOrgIdName(name: string): boolean {
  return ORG_ID_ALIAS.test(name.replace(/[_\- ]/g, "").toLowerCase());
}

/** `.omit({ organizationId: true })` removes the field; its argument is not an input field. */
function isOmitCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "omit"
  );
}

function scanForOrgId(file: string, tree: ts.SourceFile, root: ts.Node): void {
  const visit = (node: ts.Node): void => {
    if (isOmitCall(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name !== undefined && isOrgIdName(name)) {
        report(
          file,
          lineOfNode(tree, node),
          "no-org-id-in-input",
          `'${name}' is an org id in a contract input. Delete it from the input schema and read ctx.orgId, which the gateway takes from the session and signs into the envelope.`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/**
 * Follows an input value down to its root. False for anything that is not an inline
 * `z.object({ ... })` or a chain built on one declared in this file, because indirection is
 * how a field hides: move it into a non-contract file and `input: someImportedSchema` is a
 * subtree the org-id scanner can never see.
 */
function rootedInZObject(
  expression: ts.Expression,
  values: ReadonlyMap<string, ts.Expression>,
  seen: Set<string>,
  scan: ts.Node[],
): boolean {
  scan.push(expression);
  let current: ts.Node = expression;
  for (;;) {
    if (ts.isCallExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current)) {
      const owner = current.expression;
      if (current.name.text === "object" && ts.isIdentifier(owner) && owner.text === "z") {
        return true;
      }
      current = owner;
    } else if (ts.isIdentifier(current)) {
      const local = values.get(current.text);
      if (local === undefined || seen.has(current.text)) return false;
      seen.add(current.text);
      return rootedInZObject(local, values, seen, scan);
    } else {
      return false;
    }
  }
}

function checkContractInput(
  file: string,
  tree: ts.SourceFile,
  value: ts.Expression,
  values: ReadonlyMap<string, ts.Expression>,
): void {
  const scan: ts.Node[] = [];
  if (!rootedInZObject(value, values, new Set<string>(), scan)) {
    report(
      file,
      lineOfNode(tree, value),
      "no-indirect-contract-input",
      "A contract input must be an inline z.object({ ... }) here, or a chain built on one declared in this file. An imported or computed schema hides its fields from the org-id check - inline the object in this contract.",
    );
  }
  for (const node of scan) scanForOrgId(file, tree, node);
}

function contractInputs(file: string, tree: ts.SourceFile): void {
  if (!/\.contract\.ts$/.test(file)) return;
  const values = topLevelValues(tree);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(propertyName));
      // The operation shape is `{ input, output }`, and `Contract` makes both mandatory, so
      // an object carrying only one of them is not an operation - its `input` is a field.
      if (names.has("input") && names.has("output")) {
        for (const property of node.properties) {
          if (propertyName(property) === "input" && ts.isPropertyAssignment(property)) {
            checkContractInput(file, tree, property.initializer, values);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/**
 * Backstop for the Grit plugin, so the rule holds even without the plugin engine. The
 * segment class accepts an interpolation, because `rpc.${resource}.${operation}` is a
 * subject built by hand exactly as "rpc.project.read" is - the letters-only class this used
 * to carry stopped dead at `${`. `cmd.>` and `evt.>` are wildcards, not subjects: `>` is
 * outside the segment class, so a stream filter is never flagged.
 */
const SUBJECT_SEGMENT = String.raw`(?:[A-Za-z0-9_$]+|\$\{[^}]*\})+`;
const RAW_SUBJECT = new RegExp(
  String.raw`["'\`](rpc|cmd|evt)\.${SUBJECT_SEGMENT}\.${SUBJECT_SEGMENT}`,
  "g",
);

function noRawSubjects(file: string, source: string): void {
  if (/packages[/\\](registry|transport)[/\\]/.test(file)) return;
  // The one file that must contain the pattern it searches for.
  if (file.endsWith(join("tools", "guardrail-check.ts"))) return;
  for (const match of source.matchAll(RAW_SUBJECT)) {
    report(
      file,
      lineOf(source, match.index),
      "no-raw-subjects",
      `A '${match[1] ?? "rpc"}.' subject is built by hand here. Interpolating the resource and the operation is still building it by hand - use rpcSubject/commandSubject/eventSubject from @guardrail/registry so the compiler checks both halves.`,
    );
  }
}

/** The registry has one editable file. Data in derive.ts becomes a second source of truth. */
function noDataInDerive(file: string, source: string): void {
  if (!file.endsWith(join("registry", "src", "derive.ts"))) return;
  const declared = new RegExp(String.raw`^\s*(${planKeys.join("|")})\s*:`, "gm");
  for (const match of source.matchAll(declared)) {
    report(
      file,
      lineOf(source, match.index),
      "no-data-in-derive",
      `'${match[1] ?? "a plan"}' is plan data. Declare it on the plan in registry.ts; derive.ts computes from the registry, it does not declare.`,
    );
  }
}

/**
 * `defineConsumer` is correct and, until this rule, entirely optional. `consume()` and
 * `serveRpc()` take any handler and hand it whatever arrived on the subject, and exactly two
 * things in the platform check the envelope signature before a handler reads `meta.orgId`:
 * `defineConsumer`, and `defineService`'s own `handle`. A subscriber wired straight to a bare
 * async function meters a victim organisation from a forged event, and because
 * `audit_log.requestId` is unique with `onConflictDoNothing`, a forged event carrying a real
 * request id silently takes the genuine audit row's place.
 *
 * Relational, like the cross-service rule, and structural rather than textual: whether a
 * handler is safe depends on what the *same file* bound `defineService` to, which no keyword
 * scan can answer. The handler has to be written where the subscription is, for the same
 * reason a contract input has to be inline - indirection is how a check gets walked around.
 */
const BUS_SUBSCRIBERS = new Set(["consume", "serveRpc"]);
const CONSUMER_WRAPPER = "defineConsumer";
const SERVICE_FACTORY = "defineService";
const SERVICE_ENTRY = "handle";

/** True when this subtree reaches one of the two verifiers before any handler body runs. */
function reachesVerifier(
  node: ts.Node,
  values: ReadonlyMap<string, ts.Expression>,
  seen: Set<string>,
): boolean {
  // `handler: someLocal` - follow it, so a hoisted consumer is judged on what it is.
  if (ts.isIdentifier(node)) {
    const bound = values.get(node.text);
    if (bound === undefined || seen.has(node.text)) return false;
    seen.add(node.text);
    return reachesVerifier(bound, values, seen);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    // `defineConsumer({ secret }, ...)` verifies the envelope itself.
    if (ts.isIdentifier(callee) && callee.text === CONSUMER_WRAPPER) return true;
    // `runtime.handle(raw, subject)`, where this file bound `runtime` to defineService(...).
    // The command half of the block verifies inside `handle`, not in a wrapper.
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === SERVICE_ENTRY &&
      ts.isIdentifier(callee.expression)
    ) {
      const bound = values.get(callee.expression.text);
      if (
        bound !== undefined &&
        ts.isCallExpression(bound) &&
        ts.isIdentifier(bound.expression) &&
        bound.expression.text === SERVICE_FACTORY
      ) {
        return true;
      }
    }
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (reachesVerifier(child, values, seen)) found = true;
  });
  return found;
}

/** `consume({...})` / `serveRpc({...})` - the call, not `consumer.consume()`, which is NATS's. */
function isBusSubscription(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    BUS_SUBSCRIBERS.has(node.expression.text)
  );
}

/** The expression that will be handed the bytes, or undefined when it is not written here. */
function handlerBodyOf(node: ts.CallExpression): ts.Node | undefined {
  const args = node.arguments[0];
  if (args === undefined || !ts.isObjectLiteralExpression(args)) return undefined;
  const handler = args.properties.find((property) => propertyName(property) === "handler");
  if (handler === undefined) return undefined;
  if (ts.isPropertyAssignment(handler)) return handler.initializer;
  if (ts.isShorthandPropertyAssignment(handler)) return handler.name;
  return undefined;
}

function noUnverifiedConsumer(file: string, tree: ts.SourceFile): void {
  const values = topLevelValues(tree);
  const visit = (node: ts.Node): void => {
    if (isBusSubscription(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : "consume";
      const body = handlerBodyOf(node);
      if (body === undefined) {
        report(
          file,
          lineOfNode(tree, node),
          "no-unverified-consumer",
          `${name}() must be given an object literal with a 'handler' property written here, so the checker can see what receives the bytes. A handler spread in from elsewhere cannot be proved to verify the envelope.`,
        );
      } else if (!reachesVerifier(body, values, new Set<string>())) {
        report(
          file,
          lineOfNode(tree, body),
          "no-unverified-consumer",
          `This ${name}() handler never reaches an envelope verifier, so it would hand a handler meta.orgId straight off the wire. Wrap it in defineConsumer({ secret }, ...) from @guardrail/guardrail, or delegate to the handle() of a defineService(...) runtime declared in this file.`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

/* ── The Better Auth mount ───────────────────────────────────────────────── */

/**
 * Better Auth's organisation plugin mounts its own HTTP endpoints behind the catch-all, and
 * every one of them bypasses all eleven gates. Several are duplicate doors beside operations
 * the registry already gates, so they are superseded at the mount and answer 410.
 *
 * WHERE THE KNOWLEDGE LIVES, and why it is not circular. `invite-member` does not mechanically
 * equal `member:create`; that correspondence is a decision, and no rule can derive it. So the
 * decision is written down once, per endpoint, in a table beside the wrapper that enforces it -
 * not in this file, because a checker holding the list would be checking a list nothing
 * executes, and the wrapper could then diverge from it in silence.
 *
 * This rule never invents the correspondence and never validates the table against itself. It
 * compares the table with two sources neither it nor we own:
 *   1. the VENDOR - `organization().endpoints`, resolved through `packages/auth`, the package
 *      that legitimately depends on Better Auth. The endpoint set therefore comes from the
 *      library. An upgrade that adds a door and a table that does not mention it is a finding,
 *      which is the failure a hand-written list cannot survive.
 *   2. the REGISTRY - a superseding value must name an operation that actually exists.
 * Plus the mount itself: a `route.ts` that goes back to a bare `toNextJsHandler(auth)` has
 * dropped every refusal, and neither of the other two checks would notice.
 *
 * THE LIMIT, stated rather than papered over. Adding a registry operation and forgetting to
 * supersede the Better Auth door beside it cannot be caught mechanically - the correspondence
 * is knowledge, and `project.archive` has no Better Auth equivalent to compare against. What
 * this converts that risk into is: the door is one row of an exhaustive table carrying an
 * explicit written verdict, and the table can never silently fall behind the vendor.
 */
const AUTH_MOUNT = join("apps", "web", "src", "app", "api", "auth");
const SUPERSESSION_TABLE = "SUPERSEDED";
const KEPT_TABLE = "KEPT";
const AUTH_MOUNT_CALL = "toNextJsHandler";
const OPERATION_REFERENCE = /^([A-Za-z0-9_$]+):([A-Za-z0-9_$]+)$/;

/** The vendor's paths carry a leading slash and the tables are written without one. */
function bare(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Every organisation path Better Auth actually serves over HTTP. An endpoint with no `path`
 * is not mounted - `addMember` is the server-side one in 1.7.0 - and is not the mount's
 * problem. `null` means the vendor could not be read at all, which is reported rather than
 * treated as "nothing to check": a completeness check that silently compares against an empty
 * set is worse than no check.
 */
/** Anything `in` can be asked of. A vendor endpoint is a function with properties hung on it. */
function isRecordLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

async function mountedOrgEndpoints(): Promise<readonly string[] | null> {
  try {
    const from = createRequire(join(ROOT, "packages", "auth", "src", "auth.ts"));
    const loaded: unknown = await import(pathToFileURL(from.resolve("better-auth/plugins")).href);
    if (typeof loaded !== "object" || loaded === null || !("organization" in loaded)) return null;
    const factory = loaded.organization;
    if (typeof factory !== "function") return null;
    const plugin: unknown = factory();
    if (typeof plugin !== "object" || plugin === null || !("endpoints" in plugin)) return null;
    const endpoints = plugin.endpoints;
    if (typeof endpoints !== "object" || endpoints === null) return null;
    const paths: string[] = [];
    for (const endpoint of Object.values(endpoints)) {
      // A Better Auth endpoint is a *callable* carrying `.path`, not a plain object. Guarding
      // on `typeof === "object"` alone skipped every one of them and reported the vendor as
      // unreadable - correct-by-accident, and useless. Found by running it, not by reading it.
      if (!isRecordLike(endpoint) || !("path" in endpoint)) continue;
      if (typeof endpoint.path === "string") paths.push(endpoint.path);
    }
    return paths.length === 0 ? null : [...paths].sort();
  } catch {
    return null;
  }
}

/** Every `resource:operation` the registry declares, for the values in the table. */
async function operationsFromRegistry(): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  const entry = join(ROOT, "packages", "registry", "src", "registry.ts");
  const loaded: unknown = await import(pathToFileURL(entry).href);
  if (typeof loaded !== "object" || loaded === null || !("RESOURCES" in loaded)) return out;
  const resources = loaded.RESOURCES;
  if (typeof resources !== "object" || resources === null) return out;
  // Annotated rather than asserted, so the `any` Object.entries hands back is erased here.
  const declared: readonly (readonly [string, unknown])[] = Object.entries(resources);
  for (const [resource, definition] of declared) {
    if (typeof definition !== "object" || definition === null) continue;
    if (!("operations" in definition)) continue;
    const operations = definition.operations;
    if (typeof operations !== "object" || operations === null) continue;
    for (const operation of Object.keys(operations)) out.add(`${resource}:${operation}`);
  }
  return out;
}

/** `x satisfies T` and `x as const` wrap the literal; the table is what is underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isSatisfiesExpression(current) || ts.isAsExpression(current))
    current = current.expression;
  return current;
}

type Supersession = {
  readonly declaration: ts.Node;
  readonly entries: ReadonlyMap<string, string>;
};

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  for (const property of object.properties) {
    if (propertyName(property) !== name || !ts.isPropertyAssignment(property)) continue;
    const written = unwrap(property.initializer);
    if (ts.isStringLiteralLike(written)) return written.text;
  }
  return undefined;
}

/**
 * Both halves of the verdict, keyed by path: `SUPERSEDED` is a list of
 * `{ path, by, instead }` and carries the operation that replaced the endpoint; `KEPT` is a
 * path -> reason record and carries none. A path in either has been decided about, which is
 * the property this rule is checking - "we forgot" and "we decided" look identical otherwise.
 */
function namedLiteral(values: ReadonlyMap<string, ts.Expression>, name: string) {
  const value = values.get(name);
  return value === undefined ? undefined : unwrap(value);
}

/** `SUPERSEDED`: each `{ path, by }` records the operation that replaced the endpoint. */
function readSuperseded(node: ts.Expression | undefined, into: Map<string, string>): boolean {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return false;
  for (const element of node.elements) {
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) continue;
    const path = stringProperty(object, "path");
    if (path !== undefined) into.set(bare(path), stringProperty(object, "by") ?? "");
  }
  return true;
}

/** `KEPT`: path -> the reason it stays mounted. Decided about, but replaced by nothing. */
function readKept(node: ts.Expression | undefined, into: Map<string, string>): boolean {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return false;
  for (const property of node.properties) {
    const key = propertyName(property);
    if (key !== undefined) into.set(bare(key), "");
  }
  return true;
}

function supersessionIn(tree: ts.SourceFile): Supersession | undefined {
  const values = topLevelValues(tree);
  const superseded = namedLiteral(values, SUPERSESSION_TABLE);
  const kept = namedLiteral(values, KEPT_TABLE);
  const entries = new Map<string, string>();
  const hasSuperseded = readSuperseded(superseded, entries);
  const hasKept = readKept(kept, entries);
  const declaration = hasSuperseded ? superseded : hasKept ? kept : undefined;
  return declaration === undefined ? undefined : { declaration, entries };
}

/**
 * Dormant until the table exists. Today's tree has no wrapper yet, and a rule that fails for
 * work nobody has started is a rule that gets commented out. Once the table lands, flipping
 * this to "the mount exists, therefore a table must" is one condition - and it should be
 * flipped then, because until it is, deleting the table disarms the rule.
 */
const AUTH_RULE = "no-unsuperseded-auth-endpoint";

/** 1. Complete against the vendor's own list - the check that survives an upgrade. */
async function everyEndpointHasAVerdict(file: string, at: number, table: Supersession) {
  const mounted = await mountedOrgEndpoints();
  if (mounted === null) {
    report(
      file,
      at,
      AUTH_RULE,
      `${SUPERSESSION_TABLE} cannot be checked: Better Auth's organisation endpoints could not be read through packages/auth. The table is only as good as the list it is complete against, so this is a finding rather than a pass.`,
    );
    return;
  }
  for (const path of mounted) {
    if (table.entries.has(bare(path))) continue;
    report(
      file,
      at,
      AUTH_RULE,
      `Better Auth mounts '${path}' and neither ${SUPERSESSION_TABLE} nor ${KEPT_TABLE} mentions it, so it is reachable with no minRole, no permission gate, no rate limit, no plan gate and no audit event. Give it a verdict: add it to ${SUPERSESSION_TABLE} with the operation that replaces it, or to ${KEPT_TABLE} with the reason it stays open.`,
    );
  }
}

/** 2. Every superseding value names an operation the registry actually declares. */
async function everySupersederExists(file: string, at: number, table: Supersession) {
  const operations = await operationsFromRegistry();
  for (const [path, value] of table.entries) {
    if (!OPERATION_REFERENCE.test(value) || operations.has(value)) continue;
    report(
      file,
      at,
      AUTH_RULE,
      `'${path}' is superseded by '${value}', which the registry does not declare. Either the operation was removed and this door is open again, or the name is wrong.`,
    );
  }
}

function mountsBetterAuth(tree: ts.SourceFile): boolean {
  let mounts = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === AUTH_MOUNT_CALL
    ) {
      mounts = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return mounts;
}

/**
 * 3. The mount still goes through the wrapper. Neither check above sees a route.ts that was
 * simplified back to three lines, and that is the whole refusal gone.
 */
function mountReachesTheWrapper(file: string, tree: ts.SourceFile, tableFile: string): void {
  if (!mountsBetterAuth(tree)) return;
  const table = tableFile.replace(/\.tsx?$/, "");
  const reaches = moduleSpecifiers(tree).some(
    (specifier) =>
      specifier.text.startsWith(".") && resolve(dirname(file), specifier.text) === table,
  );
  if (reaches) return;
  report(
    file,
    1,
    AUTH_RULE,
    `This file mounts Better Auth with ${AUTH_MOUNT_CALL}() but never imports ${SUPERSESSION_TABLE} from ${relative(ROOT, tableFile)}, so every superseded endpoint is reachable again. The mount must go through the wrapper that refuses them.`,
  );
}

async function noUnsupersededAuthEndpoint(): Promise<void> {
  const trees = new Map<string, ts.SourceFile>();
  let tableFile: string | undefined;
  let table: Supersession | undefined;
  for (const file of walk(join(ROOT, AUTH_MOUNT))) {
    const tree = parse(file, readFileSync(file, "utf8"));
    trees.set(file, tree);
    const found = supersessionIn(tree);
    if (found === undefined) continue;
    tableFile = file;
    table = found;
  }
  if (tableFile === undefined || table === undefined) return;

  const declaredIn = trees.get(tableFile);
  const at = declaredIn === undefined ? 1 : lineOfNode(declaredIn, table.declaration);
  await everyEndpointHasAVerdict(tableFile, at, table);
  await everySupersederExists(tableFile, at, table);
  for (const [file, tree] of trees) {
    if (file !== tableFile) mountReachesTheWrapper(file, tree, tableFile);
  }
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

for (const directory of SCANNED) {
  for (const file of walk(join(ROOT, directory))) {
    const original = readFileSync(file, "utf8");
    const next = requireServerOnly(file, original);
    if (next !== original) writeFileSync(file, next);
    const tree = parse(file, next);
    noCrossServiceImport(file, tree);
    noBusinessLogicInGateway(file, tree);
    contractInputs(file, tree);
    noRawSubjects(file, next);
    noDataInDerive(file, next);
    noUnverifiedConsumer(file, tree);
  }
}

// Whole-tree rather than per-file: it compares one table against the vendor and the registry.
await noUnsupersededAuthEndpoint();

if (repaired > 0) console.info(`guardrail: repaired ${repaired} file(s)`);

if (findings.length === 0) {
  console.info("guardrail: architecture intact");
  process.exit(0);
}

for (const finding of findings) {
  console.error(`${finding.file}:${finding.line}  ${finding.rule}\n    ${finding.message}`);
}
console.error(
  `\nguardrail: ${findings.length} violation(s). Run with --fix to repair what is repairable.`,
);
process.exit(1);
