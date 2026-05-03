import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, sessionsTable, playersTable } from "@workspace/db";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import {
  NewSessionResponse,
  LoadStateQueryParams,
  LoadStateResponse,
  SaveStateBody,
  SaveStateResponse,
  GetLeaderboardResponse,
  RegisterPlayerBody,
  RegisterPlayerResponse,
  LoginPlayerBody,
  LoginPlayerResponse,
  CheckUsernameResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// 10 attempts per IP per 15 minutes on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed/all attempts count toward limit
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many attempts. Please wait 15 minutes and try again.",
      code: "RATE_LIMITED",
    });
  },
});

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

const BCRYPT_ROUNDS = 10;

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

router.get("/check-username", async (req, res) => {
  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!username) {
    res.status(400).json({ error: "username is required" });
    return;
  }
  try {
    const rows = await db
      .select({
        sessionId: playersTable.sessionId,
      })
      .from(playersTable)
      .where(eq(playersTable.username, username))
      .limit(1);

    if (rows.length === 0) {
      const data = CheckUsernameResponse.parse({ exists: false, day: null, scenario: null, wins: null, status: null });
      res.json(data);
      return;
    }

    const sessionRows = await db
      .select({
        day: sessionsTable.day,
        scenario: sessionsTable.scenario,
        wins: sessionsTable.wins,
        status: sessionsTable.status,
      })
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionId, rows[0].sessionId))
      .limit(1);

    const s = sessionRows[0] ?? null;
    const data = CheckUsernameResponse.parse({
      exists: true,
      day: s?.day ?? null,
      scenario: s?.scenario ?? null,
      wins: s?.wins ?? null,
      status: s?.status ?? null,
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to check username");
    res.status(500).json({ error: "Failed to check username" });
  }
});

const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

router.post("/register", authLimiter, async (req, res) => {
  const body = RegisterPlayerBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { password } = body;

  if (!USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: "Username may only contain letters, numbers, _ and -.", code: "INVALID_USERNAME" });
    return;
  }

  try {
    // Check if username is already taken
    const existing = await db
      .select()
      .from(playersTable)
      .where(eq(playersTable.username, username))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Username already taken. Choose a different name.", code: "USERNAME_TAKEN" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const sessionId = randomUUID();

    // Create the player account
    await db.insert(playersTable).values({ username, passwordHash, sessionId });

    // Pre-create the session row with default state
    await db.insert(sessionsTable).values({
      sessionId,
      state: { ...DEFAULT_STATE, sessionId },
      scenario: "default",
      day: 1,
      status: "playing",
      wins: 0,
    });

    const data = RegisterPlayerResponse.parse({ sessionId, username, isNewPlayer: true });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to register player");
    res.status(500).json({ error: "Registration failed. Please try again.", code: "SERVER_ERROR" });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  const body = LoginPlayerBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { password } = body;

  try {
    const rows = await db
      .select()
      .from(playersTable)
      .where(eq(playersTable.username, username))
      .limit(1);

    if (rows.length === 0) {
      // Use a generic message to avoid leaking whether username exists
      res.status(401).json({ error: "Invalid username or password.", code: "INVALID_CREDENTIALS" });
      return;
    }

    const player = rows[0];
    const passwordMatch = await bcrypt.compare(password, player.passwordHash);

    if (!passwordMatch) {
      res.status(401).json({ error: "Invalid username or password.", code: "INVALID_CREDENTIALS" });
      return;
    }

    const data = LoginPlayerResponse.parse({ sessionId: player.sessionId, username: player.username, isNewPlayer: false });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to login player");
    res.status(500).json({ error: "Login failed. Please try again.", code: "SERVER_ERROR" });
  }
});

router.get("/leaderboard", async (req, res) => {
  try {
    const rows = await db
      .select({
        sessionId: sessionsTable.sessionId,
        scenario: sessionsTable.scenario,
        day: sessionsTable.day,
        wins: sessionsTable.wins,
        state: sessionsTable.state,
        updatedAt: sessionsTable.updatedAt,
        username: playersTable.username,
      })
      .from(sessionsTable)
      .leftJoin(playersTable, eq(sessionsTable.sessionId, playersTable.sessionId))
      .where(eq(sessionsTable.status, "won"))
      .orderBy(desc(sessionsTable.day), desc(sessionsTable.wins))
      .limit(50);

    const mapped = rows.map((row) => {
      const state = row.state as {
        metrics?: { precision?: number; recall?: number; slaAdherence?: number };
        score?: number;
        grade?: string;
        maxStreak?: number;
      };
      return {
        sessionId: row.sessionId,
        username: row.username ?? null,
        scenario: row.scenario,
        day: row.day,
        wins: row.wins,
        precision: state?.metrics?.precision ?? 0,
        recall: state?.metrics?.recall ?? 0,
        slaAdherence: state?.metrics?.slaAdherence ?? 0,
        completedAt: row.updatedAt.toISOString(),
        score: state?.score ?? 0,
        grade: state?.grade ?? "D",
        maxStreak: state?.maxStreak ?? 0,
      };
    });

    const entries = mapped
      .sort((a, b) => b.score - a.score || b.precision - a.precision)
      .slice(0, 10);

    const data = GetLeaderboardResponse.parse({ entries });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to load leaderboard");
    res.status(500).json({ error: "Failed to load leaderboard" });
  }
});

export default router;
