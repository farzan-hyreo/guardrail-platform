/**
 * SOT: nats-auth-verification, permission-test, bus-authorisation-test
 * WHAT   Proves the permissions in auth.conf are the permissions the running server
 *        enforces: every allowed path succeeds, every forbidden one is refused.
 * WHY    A permission file is a claim. The interesting half of it - "identity cannot
 *        publish evt.project.create", "the gateway cannot answer for a service" - is
 *        exactly the half that no amount of running the app locally will exercise, so
 *        without this the config rots the first time somebody adds an operation.
 * HOW    Connects once per nkey and asserts on the server's Permissions Violation. It is
 *        plain JavaScript rather than a repo package so it needs no build and no install:
 *        it borrows the NATS client @guardrail/transport already depends on.
 * WHERE  Run it against a stack started by `make up`:
 *          node infra/nats/verify.mjs
 *        Exits non-zero on the first claim the server disagrees with.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const require = createRequire(pathToFileURL(join(ROOT, "packages", "transport", "package.json")));
const nats = await import(pathToFileURL(require.resolve("@nats-io/transport-node")).href);
const { connect, nkeyAuthenticator } = nats;

const SERVER = process.argv[2] ?? "nats://127.0.0.1:4222";
const encoder = new TextEncoder();

const seedOf = (user) => readFileSync(join(HERE, "creds", `${user}.nk`), "utf8").trim();

function connectAs(user) {
  return connect({
    servers: SERVER,
    name: user,
    inboxPrefix: `_INBOX.${user}`,
    authenticator: nkeyAuthenticator(encoder.encode(seedOf(user))),
    maxReconnectAttempts: 0,
  });
}

let failures = 0;
const pass = (what) => process.stdout.write(`  ok    ${what}\n`);
const fail = (what, detail) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${what}${detail ? ` - ${detail}` : ""}\n`);
};

/** A permissions violation surfaces asynchronously on the connection's status iterator. */
function watchViolations(nc) {
  const seen = [];
  (async () => {
    for await (const status of nc.status()) {
      if (status.type === "error" || String(status.type).includes("permission")) {
        seen.push(String(status.data ?? status.type));
      }
    }
  })().catch(() => undefined);
  return seen;
}

async function settle(nc) {
  try {
    await nc.flush();
  } catch {
    // A refused publish can close the flush; the violation is what we are reading.
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function expectAllowed(nc, violations, what, action) {
  const before = violations.length;
  try {
    await action();
  } catch (error) {
    fail(what, String(error?.message ?? error));
    return;
  }
  await settle(nc);
  if (violations.length > before) fail(what, violations[violations.length - 1]);
  else pass(what);
}

async function expectRefused(nc, violations, what, action) {
  const before = violations.length;
  try {
    await action();
  } catch {
    pass(what);
    return;
  }
  await settle(nc);
  if (violations.length > before) pass(what);
  else fail(what, "the server allowed it");
}

process.stdout.write(`Verifying ${SERVER}\n\nanonymous\n`);
try {
  const anonymous = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  await anonymous.close();
  fail("a connection with no credentials is refused", "it was accepted");
} catch {
  pass("a connection with no credentials is refused");
}

process.stdout.write("\ngateway\n");
{
  const nc = await connectAs("gateway");
  const violations = watchViolations(nc);
  await expectAllowed(nc, violations, "may publish rpc.project.read", () =>
    nc.publish("rpc.project.read", encoder.encode("{}")),
  );
  await expectAllowed(nc, violations, "may publish cmd.member.create", () =>
    nc.publish("cmd.member.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not publish evt.project.create", () =>
    nc.publish("evt.project.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not subscribe to rpc.project.read", () => {
    nc.subscribe("rpc.project.read");
  });
  await expectRefused(nc, violations, "may not subscribe to evt.>", () => {
    nc.subscribe("evt.>");
  });
  await nc.close();
}

process.stdout.write("\nprojects\n");
{
  const nc = await connectAs("projects");
  const violations = watchViolations(nc);
  await expectAllowed(nc, violations, "may subscribe to rpc.project.read", () => {
    nc.subscribe("rpc.project.read", { queue: "qg.projects" });
  });
  await expectAllowed(nc, violations, "may publish evt.project.create", () =>
    nc.publish("evt.project.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not publish evt.member.create", () =>
    nc.publish("evt.member.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not publish cmd.member.create", () =>
    nc.publish("cmd.member.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not subscribe to rpc.member.read", () => {
    nc.subscribe("rpc.member.read");
  });
  await expectRefused(nc, violations, "may not read another process's inbox", () => {
    nc.subscribe("_INBOX.gateway.>");
  });
  await nc.close();
}

process.stdout.write("\nrequest/reply end to end\n");
{
  const service = await connectAs("projects");
  const gateway = await connectAs("gateway");
  service.subscribe("rpc.project.read", {
    queue: "qg.projects",
    callback: (_error, message) => message.respond(encoder.encode('{"ok":true}')),
  });
  await service.flush();
  try {
    const reply = await gateway.request("rpc.project.read", encoder.encode("{}"), {
      timeout: 2000,
    });
    const body = new TextDecoder().decode(reply.data);
    if (body === '{"ok":true}') pass("a service can answer the gateway (allow_responses)");
    else fail("a service can answer the gateway", body);
  } catch (error) {
    fail("a service can answer the gateway", String(error?.message ?? error));
  }
  await service.close();
  await gateway.close();
}

process.stdout.write("\nobserver\n");
{
  const nc = await connectAs("observer");
  const violations = watchViolations(nc);
  await expectAllowed(nc, violations, "may subscribe to evt.>", () => {
    nc.subscribe("evt.>");
  });
  await expectRefused(nc, violations, "may not publish anything", () =>
    nc.publish("evt.project.create", encoder.encode("{}")),
  );
  await nc.close();
}

process.stdout.write("\nidentity (the command consumer)\n");
{
  const nc = await connectAs("identity");
  const violations = watchViolations(nc);
  await expectAllowed(nc, violations, "may publish evt.member.create", () =>
    nc.publish("evt.member.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not publish cmd.member.create", () =>
    nc.publish("cmd.member.create", encoder.encode("{}")),
  );
  await expectRefused(nc, violations, "may not publish evt.project.create", () =>
    nc.publish("evt.project.create", encoder.encode("{}")),
  );
  await nc.close();
}

/* ── JetStream ───────────────────────────────────────────────────────────────
 * The half that breaks a developer's day rather than their security: a durable command
 * that cannot be published, or a consumer that cannot ack. Run against a bootstrapped
 * stack (`make up` creates the streams), and skipped with a note if it is not.
 */
const jetstreamModule = await import(pathToFileURL(require.resolve("@nats-io/jetstream")).href);
const { jetstream, jetstreamManager, AckPolicy } = jetstreamModule;

/** snake_case is the JetStream wire API, not ours, so these are entries rather than keys. */
const consumerConfig = (durable, filter) =>
  Object.fromEntries([
    ["durable_name", durable],
    ["filter_subject", filter],
    ["ack_policy", AckPolicy.Explicit],
  ]);

const streamConfig = (name, subject) =>
  Object.fromEntries([
    ["name", name],
    ["subjects", [subject]],
    ["duplicate_window", 120e9],
  ]);

process.stdout.write("\njetstream\n");
{
  const bootstrap = await connectAs("bootstrap");
  const manager = await jetstreamManager(bootstrap);
  for (const [name, subject] of [
    ["CMD", "cmd.>"],
    ["EVT", "evt.>"],
  ]) {
    const config = streamConfig(name, subject);
    try {
      await manager.streams.add(config);
    } catch {
      await manager.streams.update(name, config);
    }
  }
  pass("bootstrap creates and updates the streams the registry declares");
  await expectRefused(bootstrap, [], "bootstrap may not publish onto them", () =>
    jetstream(bootstrap).publish("cmd.member.create", encoder.encode("{}")),
  );
  await bootstrap.close();
}
{
  const gateway = await connectAs("gateway");
  try {
    const ack = await jetstream(gateway).publish("cmd.member.create", encoder.encode("{}"), {
      msgID: `verify-${Date.now()}`,
    });
    pass(`gateway publishes a durable command (CMD seq ${ack.seq})`);
  } catch (error) {
    fail("gateway publishes a durable command", String(error?.message ?? error));
  }
  await gateway.close();
}
{
  const identity = await connectAs("identity");
  const manager = await jetstreamManager(identity);
  const durable = "verify-identity";
  try {
    await manager.consumers.add("CMD", consumerConfig(durable, "cmd.member.create"));
  } catch {
    // Already there from an earlier run.
  }
  const consumer = await jetstream(identity).consumers.get("CMD", durable);
  const messages = await consumer.consume();
  const stop = setTimeout(() => messages.stop(), 4000);
  let received = null;
  for await (const message of messages) {
    received = message.subject;
    message.ack();
    messages.stop();
    break;
  }
  clearTimeout(stop);
  if (received === "cmd.member.create") pass("identity consumes and acks a command");
  else fail("identity consumes and acks a command", "nothing arrived in 4s");
  await expectRefused(identity, [], "identity may not consume the event stream", () =>
    manager.consumers.add("EVT", consumerConfig("verify-identity-sneak", "evt.>")),
  );
  await identity.close();
}
{
  const audit = await connectAs("audit");
  const manager = await jetstreamManager(audit);
  await expectRefused(audit, [], "audit may not create a stream", () =>
    manager.streams.add(streamConfig("VERIFY_SNEAK", "sneak.>")),
  );
  await expectRefused(audit, [], "audit may not read the command stream", () =>
    manager.streams.info("CMD"),
  );
  await audit.close();
}

process.stdout.write(
  failures === 0 ? "\nEvery claim in auth.conf holds.\n" : `\n${failures} claim(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
