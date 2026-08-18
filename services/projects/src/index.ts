/**
 * SOT: projects-service-entry, service-bootstrap
 * WHAT   Boots the projects service: subscribe to the subjects the registry says it owns.
 * WHY    The subject list is derived, so a new operation in the registry is automatically
 *        served once its handler exists - and screams at boot if the handler is missing.
 * HOW    pnpm --filter @guardrail/service-projects dev. Every delivery hands the runtime
 *        the subject it arrived on, so a signed rpc envelope cannot be replayed as a command.
 * WHERE  packages/guardrail/src/service.ts
 */
import "server-only";

import { env } from "@guardrail/env";
import { defineService } from "@guardrail/guardrail";
import { queueGroup } from "@guardrail/registry";
import { closeConnection, consume, serveRpc } from "@guardrail/transport";

import { projectHandlers } from "./project.handlers";

const secret = env.envelopeSecret();

const runtime = defineService("projects", projectHandlers, { secret });

async function main() {
  for (const route of runtime.routes) {
    if (route.transport === "rpc") {
      await serveRpc({
        subject: route.subject,
        queue: queueGroup("projects"),
        handler: (raw, subject) => runtime.handle(raw, subject),
        unreadable: runtime.unreadable,
      });
    } else {
      void consume({
        stream: "CMD",
        durable: `projects-${route.resource}-${route.operation}`,
        filterSubject: route.subject,
        handler: async (raw, subject) => {
          const reply = await runtime.handle(raw, subject);
          if (!reply.ok) throw new Error(reply.error.message);
        },
      });
    }
    console.info(`[projects] serving ${route.subject} (${route.transport})`);
  }
}

main().catch((error) => {
  console.error("[projects] failed to start", error);
  process.exit(1);
});

process.on("SIGINT", () => void closeConnection().then(() => process.exit(0)));
process.on("SIGTERM", () => void closeConnection().then(() => process.exit(0)));
