/**
 * SOT: guardrail-check, architecture-check, boundary-check, cross-service-lint
 * WHAT   The architecture rules Biome cannot express, checked in one fast pass.
 * WHY    Biome's GritQL plugins match patterns inside a file. Three of these rules compare
 *        a file's own path to what it imports, which no pattern language can see. A rule
 *        you cannot express is a rule you do not have, so they live here instead.
 * HOW    `pnpm guardrail` to check, `pnpm guardrail --fix` to repair what is repairable.
 *        Runs in `pnpm verify` and takes well under a second on this repo.
 * WHERE  package.json (verify), CI
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

type Finding = { file: string; line: number; rule: string; message: string };

const ROOT = process.cwd();
const fix = process.argv.includes("--fix");
const findings: Finding[] = [];
let repaired = 0;

const SKIP = new Set(["node_modules", ".next", ".turbo", "dist", "drizzle", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
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

/* ── Rules ───────────────────────────────────────────────────────────────── */

/** Anything that reaches a database, a secret or the bus must never reach the browser. */
function requireServerOnly(file: string, source: string): string {
  const applies = /\.(service|adapter|handlers)\.ts$/.test(file) || /[/\\]src[/\\]db\.ts$/.test(file);
  if (!applies || source.includes('import "server-only"')) return source;
  if (fix) {
    repaired += 1;
    return `import "server-only";\n\n${source}`;
  }
  report(file, 1, "require-server-only", 'Missing `import "server-only";`.');
  return source;
}

/** Services talk over subjects. An import is a shared deployment by another name. */
function noCrossServiceImport(file: string, source: string): void {
  const own = /services[/\\]([^/\\]+)/.exec(file)?.[1];
  if (own === undefined) return;
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const target = /services[/\\]([^/\\]+)/.exec(match[1] ?? "")?.[1];
    if (target !== undefined && target !== own) {
      report(
        file,
        lineOf(source, match.index),
        "no-cross-service-import",
        `Service '${own}' imports service '${target}'. Talk over a subject, or share types via @guardrail/contracts.`,
      );
    }
  }
}

/** A gateway route is a routing decision. Anything else belongs to the owning service. */
function noBusinessLogicInGateway(file: string, source: string): void {
  if (!/gateway[/\\]routers[/\\]/.test(file)) return;
  for (const match of source.matchAll(/\b(if|for|while|switch|await|try)\b/g)) {
    report(
      file,
      lineOf(source, match.index),
      "no-business-logic-in-gateway",
      `The gateway may not use '${match[1]}'. A route is one line: gatewayQuery/gatewayMutation.`,
    );
  }
}

/**
 * The single highest-value check in this file. An org id accepted as input is a
 * cross-tenant leak waiting for its first agent-written endpoint - the gateway takes it
 * from the session and signs it, so no schema ever needs to ask for one.
 */
function noOrgIdInInput(file: string, source: string): void {
  if (!/\.contract\.ts$/.test(file)) return;
  for (const match of source.matchAll(/\b(organizationId|orgId|organisationId)\s*:/g)) {
    report(
      file,
      lineOf(source, match.index),
      "no-org-id-in-input",
      "Contract inputs must never accept an org id. It comes from the signed envelope as ctx.orgId.",
    );
  }
}

/** Backstop for the Grit plugin, so the rule holds even without the plugin engine. */
function noRawSubjects(file: string, source: string): void {
  if (/packages[/\\](registry|transport)[/\\]/.test(file) || file.endsWith("guardrail-check.ts")) return;
  for (const match of source.matchAll(/["'`](rpc|cmd|evt)\.[a-zA-Z]+\.[a-zA-Z]+/g)) {
    report(
      file,
      lineOf(source, match.index),
      "no-raw-subjects",
      "Use rpcSubject/commandSubject/eventSubject from @guardrail/registry.",
    );
  }
}

/** The registry has one editable file. Data in derive.ts becomes a second source of truth. */
function noDataInDerive(file: string, source: string): void {
  if (!file.endsWith(join("registry", "src", "derive.ts"))) return;
  for (const match of source.matchAll(/^\s*(free|pro|scale)\s*:/gm)) {
    report(
      file,
      lineOf(source, match.index),
      "no-data-in-derive",
      "Plan data belongs in registry.ts. derive.ts computes, it does not declare.",
    );
  }
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

for (const file of [...walk(join(ROOT, "apps")), ...walk(join(ROOT, "packages")), ...walk(join(ROOT, "services"))]) {
  const original = readFileSync(file, "utf8");
  const next = requireServerOnly(file, original);
  if (next !== original) writeFileSync(file, next);
  noCrossServiceImport(file, next);
  noBusinessLogicInGateway(file, next);
  noOrgIdInInput(file, next);
  noRawSubjects(file, next);
  noDataInDerive(file, next);
}

if (repaired > 0) console.info(`guardrail: repaired ${repaired} file(s)`);

if (findings.length === 0) {
  console.info("guardrail: architecture intact");
  process.exit(0);
}

for (const finding of findings) {
  console.error(`${finding.file}:${finding.line}  ${finding.rule}\n    ${finding.message}`);
}
console.error(`\nguardrail: ${findings.length} violation(s). Run with --fix to repair what is repairable.`);
process.exit(1);
