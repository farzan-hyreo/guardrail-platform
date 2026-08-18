/**
 * SOT: nats-auth, nats-nkeys, nats-permissions, bus-authorisation, credential-generation
 * WHAT   Generates infra/nats/auth.conf: one NATS account, one nkey user per process, and
 *        the exact subjects each of those users may publish and subscribe to.
 * WHY    Until this existed the bus had no authentication at all, so "an attacker with NATS
 *        credentials" meant "anything that can reach :4222". The envelope HMAC was the only
 *        trust anchor. With per-user permissions a forged command, a forged event and a
 *        raced rpc reply stop being detectable and start being unreachable: the server
 *        refuses the publish before any of our code sees it.
 * HOW    Nothing here is a hand-written subject or a hand-written service list. Ownership,
 *        transport and the evt subject of every operation come from the registry's own
 *        ROUTES table, which is the same table defineService binds handlers against. Add an
 *        operation to registry.ts, re-run this, and the permission appears. Keys are only
 *        created for a user that does not have one yet, so re-running is idempotent.
 * WHERE  infra/nats/nats.conf includes the output; infra/docker-compose.yml mounts it;
 *        infra/nats/RUNBOOK.md explains how a developer and a deployment use it.
 *
 *   pnpm exec tsx infra/nats/generate-auth.ts            # create anything missing
 *   pnpm exec tsx infra/nats/generate-auth.ts --check    # fail if auth.conf has drifted
 *   pnpm exec tsx infra/nats/generate-auth.ts --rotate   # new keys for every user
 *   pnpm exec tsx infra/nats/generate-auth.ts --out DIR  # write a deployment's own keys
 */
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RESOURCES, ROUTES, SERVICES, STREAMS } from "../../packages/registry/src/index";

/* ── nkeys ───────────────────────────────────────────────────────────────────
 * An nkey is base32(prefix ++ payload ++ crc16le). Implemented here rather than
 * imported so this script has no dependency of its own; the output is checked against
 * @nats-io/nkeys in infra/nats/verify.mjs, and against nats-server itself by connecting.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** CRC-16/XMODEM, the checksum nkeys appends. Table built once at module load. */
const CRC_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[index] = crc;
  }
  return table;
})();

function withChecksum(raw: readonly number[]): Uint8Array {
  let crc = 0;
  for (const byte of raw) {
    crc = (((crc << 8) & 0xffff) ^ (CRC_TABLE[((crc >> 8) ^ byte) & 0xff] ?? 0)) & 0xffff;
  }
  return Uint8Array.from([...raw, crc & 0xff, (crc >> 8) & 0xff]);
}

const PREFIX_SEED = 18 << 3;
const PREFIX_USER = 20 << 3;
/** The fixed PKCS#8 header for a raw Ed25519 private key, so node can import a bare seed. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

function encodeSeed(rawSeed: Buffer): string {
  const first = PREFIX_SEED | (PREFIX_USER >> 5);
  const second = (PREFIX_USER & 31) << 3;
  return base32(withChecksum([first, second, ...rawSeed]));
}

function decodeSeed(seed: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of seed) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error(`'${seed.slice(0, 4)}...' is not a valid nkey seed.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Two prefix bytes at the front, two checksum bytes at the back.
  return Buffer.from(bytes.slice(2, 34));
}

function publicKeyOf(rawSeed: Buffer): string {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, rawSeed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return base32(withChecksum([PREFIX_USER, ...spki.subarray(spki.length - 32)]));
}

/* ── Permissions, derived ────────────────────────────────────────────────────
 * Five kinds of subject exist on this bus and every one of them is computed:
 *   rpc.<resource>.<operation>   ROUTES, transport "rpc"
 *   cmd.<resource>.<operation>   ROUTES, transport "command"
 *   evt.<resource>.<operation>   ROUTES, route.event - only where the registry audits
 *   _INBOX.<user>.>              request/reply, scoped per credential
 *   $JS.API.* / $JS.ACK.>        JetStream, scoped to the streams a user actually uses
 */

type Permissions = {
  readonly publish: readonly string[];
  readonly subscribe: readonly string[];
  /** Lets a responder answer the request it just received without naming any inbox. */
  readonly allowResponses: boolean;
};

type User = {
  readonly name: string;
  readonly account: "APP" | "SYS";
  readonly why: string;
  readonly permissions: Permissions | null;
};

const JS_API_INFO = "$JS.API.INFO";

/** Everything a pull consumer on one stream has to be able to ask for. */
function consumerApi(stream: string): readonly string[] {
  return [
    `$JS.API.STREAM.INFO.${stream}`,
    `$JS.API.CONSUMER.CREATE.${stream}`,
    `$JS.API.CONSUMER.CREATE.${stream}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${stream}.*`,
    `$JS.API.CONSUMER.INFO.${stream}.*`,
    `$JS.API.CONSUMER.MSG.NEXT.${stream}.*`,
  ];
}

function streamApi(stream: string): readonly string[] {
  return [
    `$JS.API.STREAM.CREATE.${stream}`,
    `$JS.API.STREAM.UPDATE.${stream}`,
    `$JS.API.STREAM.INFO.${stream}`,
  ];
}

const inbox = (user: string): string => `_INBOX.${user}.>`;

const STREAM_NAMES: readonly string[] = STREAMS.map((stream) => stream.name);

/** The stream a transport lands in: "command" is durable, so cmd.> is the CMD stream. */
function streamCarrying(transport: "rpc" | "command"): string | null {
  const subjectPrefix = transport === "command" ? "cmd." : null;
  if (subjectPrefix === null) return null;
  const match = STREAMS.find((stream) =>
    stream.subjects.some((subject) => subject.startsWith(subjectPrefix)),
  );
  return match?.name ?? null;
}

const EVENT_STREAM: string | null =
  STREAMS.find((stream) => stream.subjects.some((subject) => subject.startsWith("evt.")))?.name ??
  null;

/**
 * Which service runs the trail and which runs the meter, taken from the registry rather
 * than from a list of service names: the audit trail belongs to whoever owns the auditLog
 * resource, and the meter to whoever owns billing. Rename either owner in registry.ts and
 * this follows.
 */
const EVENT_CONSUMERS: readonly string[] = [
  ...new Set([RESOURCES.auditLog.owner, RESOURCES.billing.owner]),
];

function gatewayUser(): User {
  return {
    name: "gateway",
    account: "APP",
    why: "The Next.js gateway. Calls every operation the registry declares and nothing else. It never subscribes to an rpc subject, so it cannot answer for a service.",
    permissions: {
      // Every subject a dispatch can legally address - rpc and cmd alike, from ROUTES.
      publish: ROUTES.map((route) => route.subject).sort(),
      subscribe: [inbox("gateway")],
      allowResponses: false,
    },
  };
}

function serviceUser(service: string): User {
  const owned = ROUTES.filter((route) => route.owner === service);
  const serves = owned.filter((route) => route.transport === "rpc").map((route) => route.subject);
  const emits = owned.flatMap((route) => (route.event === null ? [] : [route.event]));

  const commandStreams = [
    ...new Set(
      owned.flatMap((route) => {
        const stream = streamCarrying(route.transport);
        return stream === null ? [] : [stream];
      }),
    ),
  ];
  const eventStreams =
    EVENT_CONSUMERS.includes(service) && EVENT_STREAM !== null ? [EVENT_STREAM] : [];
  const consumed = [...new Set([...commandStreams, ...eventStreams])];

  const jetstream =
    consumed.length === 0 ? [] : [JS_API_INFO, ...consumed.flatMap(consumerApi), "$JS.ACK.>"];

  return {
    name: service,
    account: "APP",
    why: [
      `Owns ${[...new Set(owned.map((route) => route.resource))].join(", ")}.`,
      serves.length === 0 ? "" : `Answers ${serves.length} rpc subject(s).`,
      emits.length === 0 ? "" : `Emits ${emits.length} evt subject(s).`,
      consumed.length === 0 ? "" : `Consumes the ${consumed.join(" and ")} stream.`,
    ]
      .filter((part) => part.length > 0)
      .join(" "),
    permissions: {
      // A service publishes its own events, acks its own deliveries, and nothing else.
      // The rpc reply is covered by allow_responses, which is bound to the message it
      // answers - so a service cannot publish into an inbox it was not asked to.
      publish: [...emits, ...jetstream].sort(),
      subscribe: [...serves, inbox(service)].sort(),
      allowResponses: serves.length > 0,
    },
  };
}

function bootstrapUser(): User {
  return {
    name: "bootstrap",
    account: "APP",
    why: "`pnpm nats:bootstrap`. Creates and updates the streams the registry declares. It cannot publish a message onto any of them.",
    permissions: {
      publish: [JS_API_INFO, ...STREAM_NAMES.flatMap(streamApi)].sort(),
      subscribe: [inbox("bootstrap")],
      allowResponses: false,
    },
  };
}

function observerUser(): User {
  return {
    name: "observer",
    account: "APP",
    why: "`make logs`. Read-only tap on the event stream for debugging. Events carry orgId, userId and role, so this is a development credential - a deployment should not issue one.",
    permissions: {
      publish: [],
      subscribe: ["evt.>", inbox("observer")],
      allowResponses: false,
    },
  };
}

const USERS: readonly User[] = [
  gatewayUser(),
  ...SERVICES.map(serviceUser),
  bootstrapUser(),
  observerUser(),
  {
    name: "sysadmin",
    account: "SYS",
    why: "`nats server report` and friends. In the system account, so it can read $SYS.> and touch nothing in APP.",
    permissions: null,
  },
];

/* ── Rendering ───────────────────────────────────────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));

function quoted(subjects: readonly string[]): string {
  return subjects.map((subject) => `"${subject}"`).join(", ");
}

function renderPermissions(permissions: Permissions): string {
  const lines = [
    "        permissions: {",
    permissions.publish.length === 0
      ? '          publish: { deny: [">"] }'
      : `          publish: { allow: [${quoted(permissions.publish)}] }`,
    `          subscribe: { allow: [${quoted(permissions.subscribe)}] }`,
  ];
  if (permissions.allowResponses) {
    // 30s covers the longest timeout the registry declares plus a slow handler; a reply
    // after that is a reply nobody is waiting for.
    lines.push('          allow_responses: { max: 1, expires: "30s" }');
  }
  lines.push("        }");
  return lines.join("\n");
}

function renderUser(user: User, publicKey: string): string {
  const wrapped = user.why.match(/.{1,80}(\s|$)/g) ?? [user.why];
  const comment = wrapped.map((line) => `      # ${line.trim()}`).join("\n");
  const body = ["      {", `        nkey: "${publicKey}"`];
  if (user.permissions !== null) body.push(renderPermissions(user.permissions));
  body.push("      }");
  return `${comment}\n${body.join("\n")}`;
}

function renderConfig(publicKeys: ReadonlyMap<string, string>): string {
  const forAccount = (account: "APP" | "SYS"): string =>
    USERS.filter((user) => user.account === account)
      .map((user) => renderUser(user, publicKeys.get(user.name) ?? ""))
      .join("\n\n");

  return `# SOT: nats-accounts, nats-authorisation, bus-permissions
# GENERATED by infra/nats/generate-auth.ts - do not edit. Every subject below is computed
# from packages/registry/src/registry.ts; a permission written here by hand is a permission
# that will disagree with the routes defineService binds at boot.
#
# Regenerate:  pnpm exec tsx infra/nats/generate-auth.ts
# Verify:      pnpm exec tsx infra/nats/generate-auth.ts --check
#
# There is no anonymous user and no no_auth_user: a connection that cannot present one of
# the nkeys below is refused at the server, before the envelope HMAC is ever consulted.

accounts: {
  # One trust domain, many least-privileged identities. Separate accounts per service would
  # need service exports/imports for every rpc subject and a JetStream domain each; the
  # boundary that actually matters here - who may publish a cmd, an evt or an rpc reply -
  # is enforced per user, which is where the registry's ownership already lives.
  APP: {
    jetstream: enabled

    users: [
${forAccount("APP")}
    ]
  }

  SYS: {
    users: [
${forAccount("SYS")}
    ]
  }
}

system_account: SYS
`;
}

/* ── Keys on disk ────────────────────────────────────────────────────────── */

type Args = {
  readonly check: boolean;
  readonly rotate: boolean;
  readonly outDir: string;
};

function parseArgs(argv: readonly string[]): Args {
  const outIndex = argv.indexOf("--out");
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  return {
    check: argv.includes("--check"),
    rotate: argv.includes("--rotate"),
    outDir: out === undefined ? join(HERE, "creds") : resolve(out),
  };
}

function loadOrCreateSeed(outDir: string, user: string, rotate: boolean): string {
  const path = join(outDir, `${user}.nk`);
  if (!rotate && existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.startsWith("SU")) return existing;
  }
  const seed = encodeSeed(randomBytes(32));
  writeFileSync(path, `${seed}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the file lives beside the repo either way.
  }
  return seed;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const configPath = join(HERE, "auth.conf");

  if (args.check) {
    if (!existsSync(configPath)) {
      console.error("infra/nats/auth.conf does not exist. Run generate-auth.ts.");
      process.exit(1);
    }
    const current = readFileSync(configPath, "utf8");
    const keys = new Map(
      USERS.map((user) => {
        const seedPath = join(args.outDir, `${user.name}.nk`);
        if (!existsSync(seedPath)) return [user.name, ""];
        return [user.name, publicKeyOf(decodeSeed(readFileSync(seedPath, "utf8").trim()))];
      }),
    );
    const expected = renderConfig(keys);
    if (current !== expected) {
      console.error(
        "infra/nats/auth.conf has drifted from the registry. Run:\n  pnpm exec tsx infra/nats/generate-auth.ts",
      );
      process.exit(1);
    }
    console.info("infra/nats/auth.conf matches the registry.");
    return;
  }

  mkdirSync(args.outDir, { recursive: true });

  const publicKeys = new Map<string, string>();
  const envLines: string[] = [];
  for (const user of USERS) {
    const seed = loadOrCreateSeed(args.outDir, user.name, args.rotate);
    publicKeys.set(user.name, publicKeyOf(decodeSeed(seed)));
    envLines.push(`NATS_USER=${user.name}`, `NATS_NKEY_SEED=${seed}`);
    writeFileSync(
      join(args.outDir, `${user.name}.env`),
      `# Credentials for the '${user.name}' NATS user. Load these into that process only.\nNATS_USER=${user.name}\nNATS_NKEY_SEED=${seed}\n`,
      { mode: 0o600 },
    );
  }

  writeFileSync(configPath, renderConfig(publicKeys));

  console.info(`Wrote ${configPath}`);
  console.info(`Wrote ${USERS.length} seed(s) and env file(s) to ${args.outDir}`);
  for (const user of USERS) {
    const permissions = user.permissions;
    const summary =
      permissions === null
        ? "system account, unrestricted within $SYS"
        : `${permissions.publish.length} publish, ${permissions.subscribe.length} subscribe${permissions.allowResponses ? ", may answer a request" : ""}`;
    console.info(`  ${user.name.padEnd(10)} ${summary}`);
  }
}

main();
