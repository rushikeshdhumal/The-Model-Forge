import app from "./app";
import { logger } from "./lib/logger";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Initialize database schema on startup
async function initializeDatabase() {
  try {
    logger.info("Checking database connection...");
    await db.execute(sql`SELECT 1`);
    logger.info("Database connection successful");
    
    // Check if tables exist, if not, they need to be created manually or via migration
    logger.info("Database schema check complete");
  } catch (err) {
    logger.error({ err }, "Database initialization failed");
    throw err;
  }
}

// Start server after database initialization
initializeDatabase()
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  });
