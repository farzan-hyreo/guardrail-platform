/**
 * SOT: autumn-plan, billing-sync, registry-to-autumn
 * Prints the Autumn features and product limits the registry implies. Keeps the direction
 * of truth honest: the registry decides, Autumn is configured to match.
 */
import { PLANS, PLAN_KEYS, RESOURCES, RESOURCE_KEYS } from "../packages/registry/src/index";

const metered = RESOURCE_KEYS.filter((key) => RESOURCES[key].featureId !== null);

console.info("Features to define in Autumn:");
for (const resource of metered) {
  console.info(`  ${RESOURCES[resource].featureId}  (${RESOURCES[resource].label})`);
}

console.info("\nProduct limits:");
for (const plan of PLAN_KEYS) {
  console.info(`\n  ${PLANS[plan].autumnProductId}  ($${PLANS[plan].priceMonthlyUsd}/mo)`);
  for (const resource of metered) {
    const limit = RESOURCES[resource].limits[plan];
    const value = limit === false ? "not included" : String(limit);
    console.info(`    ${RESOURCES[resource].featureId}: ${value}`);
  }
}
