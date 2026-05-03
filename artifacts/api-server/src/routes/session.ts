import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc, isNotNull } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import {
  NewSessionResponse,
  LoadStateQueryParams,
  LoadStateResponse,
  SaveStateBody,
  SaveStateResponse,
  GetLeaderboardResponse,
  IdentifyPlayerBody,
  IdentifyPlayerResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const DEFAULT_STATE = {
  sessionId: "",
  scenario: "default",
  day: 1,
  status: "playing",
  metrics: {
    precision: 85,
    recall: 80,
    featureStaleness: 2,
    inferenceCost: 10,
    slaAdherence: 99,
    skew: "Low",
  },
  registry: {
    models: [
      {
        id: "model_v1",
        type: "XGBoost",
        version: "1.0",
        stage: "production",
        trainedOnDay: 0,
        dataVersion: "dataset_20250428",
        accuracy: 85,
        cost: 0.1,
        latency: 15,
        explainability: "Medium",
      },
    ],
    productionModelId: "model_v1",
  },
  featureStore: {
    enabled: false,
    stalenessHours: 6,
    featureVersions: ["user_ltv_v1"],
  },
  ciCd: { autoRetrain: false, testPassRate: 1.0 },
  eventLog: [],
  futureEffects: [],
  history: [],
  userLevel: "intern",
  wins: 0,
};

router.get("/new-session", (_req, res) => {
  const sessionId = randomUUID();
  const data = NewSessionResponse.parse({ sessionId });
  res.json(data);
});

router.get("/load-state", async (req, res) => {
  const params = LoadStateQueryParams.parse(req.query);
  const { session_id } = params;

  try {
    const rows = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionId, session_id))
      .limit(1);

    if (rows.length === 0) {
      const defaultState = { ...DEFAULT_STATE, sessionId: session_id };
      const data = LoadStateResponse.parse({ state: defaultState, isDefault: true });
      res.json(data);
      return;
    }

    const data = LoadStateResponse.parse({ state: rows[0].state, isDefault: false });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to load state");
    res.status(500).json({ error: "Failed to load state" });
  }
});

router.post("/save-state", async (req, res) => {
  const body = SaveStateBody.parse(req.body);
  const { sessionId, state } = body;

  try {
    await db
      .insert(sessionsTable)
      .values({
        sessionId,
        state: state as Record<string, unknown>,
        scenario: (state as { scenario?: string }).scenario ?? "default",
        day: (state as { day?: number }).day ?? 1,
        status: (state as { status?: string }).status ?? "playing",
        wins: (state as { wins?: number }).wins ?? 0,
      })
      .onConflictDoUpdate({
        target: sessionsTable.sessionId,
        set: {
          state: state as Record<string, unknown>,
          scenario: (state as { scenario?: string }).scenario ?? "default",
          day: (state as { day?: number }).day ?? 1,
          status: (state as { status?: string }).status ?? "playing",
          wins: (state as { wins?: number }).wins ?? 0,
          updatedAt: new Date(),
        },
      });

    const data = SaveStateResponse.parse({ success: true });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to save state");
    res.status(500).json({ error: "Failed to save state" });
  }
});

router.post("/identify", async (req, res) => {
  const body = IdentifyPlayerBody.parse(req.body);
  const { username, sessionId } = body;

  const normalised = username.trim().toLowerCase();

  try {
    // Look up existing record for this username
    const existing = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.username, normalised))
      .limit(1);

    if (existing.length > 0) {
      // Username already exists — returning player
      const row = existing[0];
      // If caller supplied a sessionId and it's different, the username is taken
      if (sessionId && row.sessionId !== sessionId) {
        // Return the existing session — the frontend will switch to it
        const data = IdentifyPlayerResponse.parse({
          sessionId: row.sessionId,
          username: row.username ?? normalised,
          isExistingPlayer: true,
        });
        res.json(data);
        return;
      }
      const data = IdentifyPlayerResponse.parse({
        sessionId: row.sessionId,
        username: row.username ?? normalised,
        isExistingPlayer: true,
      });
      res.json(data);
      return;
    }

    // New username — claim it on the given session (or create a fresh session)
    const targetSessionId = sessionId ?? randomUUID();

    // Ensure the session row exists before we try to set the username
    await db
      .insert(sessionsTable)
      .values({
        sessionId: targetSessionId,
        state: { ...DEFAULT_STATE, sessionId: targetSessionId },
        scenario: "default",
        day: 1,
        status: "playing",
        wins: 0,
        username: normalised,
      })
      .onConflictDoUpdate({
        target: sessionsTable.sessionId,
        set: { username: normalised, updatedAt: new Date() },
      });

    const data = IdentifyPlayerResponse.parse({
      sessionId: targetSessionId,
      username: normalised,
      isExistingPlayer: false,
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to identify player");
    res.status(500).json({ error: "Failed to identify player", code: "SERVER_ERROR" });
  }
});

router.get("/leaderboard", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.status, "won"))
      .orderBy(desc(sessionsTable.day))
      .limit(10);

    const entries = rows.map((row) => {
      const state = row.state as {
        metrics?: { precision?: number; recall?: number; slaAdherence?: number };
      };
      return {
        sessionId: row.sessionId,
        scenario: row.scenario,
        day: row.day,
        precision: state?.metrics?.precision ?? 0,
        recall: state?.metrics?.recall ?? 0,
        slaAdherence: state?.metrics?.slaAdherence ?? 0,
        completedAt: row.updatedAt.toISOString(),
      };
    });

    const data = GetLeaderboardResponse.parse({ entries });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to load leaderboard");
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

export default router;
