import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@guardrail/auth";

export const { GET, POST } = toNextJsHandler(auth);
