import { pgTable, text, jsonb, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const sessionsTable = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  state: jsonb("state").notNull(),
  scenario: text("scenario").notNull().default("default"),
  day: integer("day").notNull().default(1),
  status: text("status").notNull().default("playing"),
  wins: integer("wins").notNull().default(0),
  username: text("username"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [unique("sessions_username_unique").on(t.username)]);

export const insertSessionSchema = createInsertSchema(sessionsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessionsTable.$inferSelect;
