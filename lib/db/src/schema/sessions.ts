import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playersTable = pgTable("players", {
  username: text("username").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  sessionId: text("session_id").notNull(),
  recoveryHash: text("recovery_hash"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessionsTable = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  state: jsonb("state").notNull(),
  scenario: text("scenario").notNull().default("default"),
  day: integer("day").notNull().default(1),
  status: text("status").notNull().default("playing"),
  wins: integer("wins").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
export type Player = typeof playersTable.$inferSelect;
