import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep a small pool — this is a single-server game app
  max: 10,
  // Release idle connections after 30 s to avoid exhausting server limits
  idleTimeoutMillis: 30_000,
  // Fail fast if a connection can't be acquired within 5 s
  connectionTimeoutMillis: 5_000,
});

// Unhandled pool errors (e.g. dropped connections) must be caught or they crash
// the process via Node's unhandledRejection handler
pool.on("error", (err) => {
  console.error("[db] Unexpected PostgreSQL pool error:", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
