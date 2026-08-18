import "server-only";

import { createDb } from "@guardrail/db";

import * as schema from "./schema";

export const db = createDb(schema);
