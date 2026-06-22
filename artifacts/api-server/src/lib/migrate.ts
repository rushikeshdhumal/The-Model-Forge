import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export async function runMigrations() {
  try {
    logger.info("Running database migrations...");
    
    // Create players table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS players (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        recovery_hash TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Create sessions table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        scenario TEXT NOT NULL DEFAULT 'default',
        day INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'playing',
        wins INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Create indexes
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_players_session_id ON players(session_id)
    `);
    
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_sessions_status_score_day ON sessions(status, score, day)
    `);
    
    logger.info("Database migrations completed successfully");
  } catch (err) {
    logger.error({ err }, "Database migration failed");
    throw err;
  }
}

// Made with Bob
