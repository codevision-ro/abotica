import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
