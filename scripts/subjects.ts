/**
 * SOT: subjects-script, subject-listing
 * Prints every subject the registry generates, grouped by the service that answers it.
 * A subject missing here means the registry is missing an operation.
 */
import { RESOURCES, ROUTES, SERVICES, resourcesOwnedBy } from "../packages/registry/src/index";

for (const service of SERVICES) {
  console.info(`\n${service}`);
  for (const resource of resourcesOwnedBy(service)) {
    for (const route of ROUTES.filter((candidate) => candidate.resource === resource)) {
      const emits = route.audit ? `  → evt.${route.resource}.${route.operation}` : "";
      console.info(`  ${route.subject.padEnd(30)} ${RESOURCES[resource].label}${emits}`);
    }
  }
}
console.info("\nStreams: CMD (cmd.>), EVT (evt.>)");
