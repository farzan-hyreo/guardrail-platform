import { defineConfig } from "drizzle-kit";

// Each service owns its schema and its migrations. Nothing else may migrate these tables.
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
