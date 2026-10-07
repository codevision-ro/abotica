import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const globalForDb = globalThis as unknown as { aboticaSql?: postgres.Sql };

/** One pool per process; reused across Next.js hot reloads. */
const sql = globalForDb.aboticaSql ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.aboticaSql = sql;

export const db = drizzle(sql, { schema, casing: "snake_case" });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
