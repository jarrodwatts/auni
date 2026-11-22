import { defineConfig } from "drizzle-kit";

// Generation needs no live database, only the schema module. `auni` applies
// migrations (src/db/migrations.ts); dbCredentials is for local drizzle-kit use.
export default defineConfig({
  dialect: "postgresql",
  // Core's tables, and each app's own in its folder's tables.ts.
  schema: ["./src/db/schema.ts", "./src/apps/*/tables.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/auni_core" },
  strict: true,
  verbose: true,
});
