import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
await sql`CREATE EXTENSION IF NOT EXISTS vector`;
await migrate(drizzle(sql), { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
await sql.end();
console.log("Migrations applied");
