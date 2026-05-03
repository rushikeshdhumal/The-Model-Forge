import { pgTable, text, jsonb, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playersTable = pgTable("players", {
  username: text("username").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  sessionId: text("session_id").notNull(),
  recoveryHash: text("recovery_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Used by leaderboard LEFT JOIN and check-username JOIN
  index("idx_players_session_id").on(t.sessionId),
]);

export const sessionsTable = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  state: jsonb("state").notNull(),
  scenario: text("scenario").notNull().default("default"),
  day: integer("day").notNull().default(1),
  status: text("status").notNull().default("playing"),
  wins: integer("wins").notNull().default(0),
  // Extracted from state at write-time so the leaderboard query never needs
  // a JSONB operator and can be fully satisfied by the composite index below
  score: integer("score").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // Covers leaderboard: WHERE status='won' ORDER BY score DESC, day DESC LIMIT 10
  index("idx_sessions_status_score_day").on(t.status, t.score, t.day),
]);

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
export type Player = typeof playersTable.$inferSelect;
