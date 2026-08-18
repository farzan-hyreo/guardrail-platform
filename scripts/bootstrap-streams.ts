/**
 * SOT: bootstrap-streams, nats-bootstrap
 * Creates or updates the JetStream streams the registry declares. Idempotent - run it
 * after `make up`, after changing STREAMS, and in CI before integration tests.
 */
import { closeConnection, ensureStreams, natsUrl } from "../packages/transport/src/index";

async function main() {
  console.log(`Connecting to ${natsUrl()}`);
  for (const line of await ensureStreams()) console.log(`  ${line}`);
  await closeConnection();
}

main().catch((error) => {
  console.error("Could not reach NATS. Is `make up` running?", error);
  process.exit(1);
});
