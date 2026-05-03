import { Router, type IRouter } from "express";
import { randomUUID, randomBytes } from "crypto";
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
  GenerateRecoveryBody,
  GenerateRecoveryResponse,
  ResetPasswordBody,
  ResetPasswordResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

// Auth operations that mutate credentials — 10 failed attempts per IP per 15 min
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failed attempts (login / register / reset)
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many attempts. Please wait 15 minutes and try again.",
      code: "RATE_LIMITED",
    });
  },
});

// Recovery-code generation: count ALL requests (successful too) to prevent
// an attacker with valid credentials from looping to invalidate a victim's code
const recoveryGenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many recovery code requests. Please wait 15 minutes and try again.",
      code: "RATE_LIMITED",
    });
  },
});

// Username lookup — light rate limit to prevent enumeration at scale
const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many lookup requests. Please slow down.",
      code: "RATE_LIMITED",
    });
  },
});

// General write limiter — save-state / new-session (prevent DB flooding)
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please slow down.",
      code: "RATE_LIMITED",
    });
  },
});

// General read limiter — leaderboard / load-state
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests. Please slow down.",
      code: "RATE_LIMITED",
    });
  },
});

// ── Shared constants ──────────────────────────────────────────────────────────

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

// Dummy hash used to equalise timing in paths that would otherwise skip bcrypt.compare
const DUMMY_HASH = "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012346";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Generate a cryptographically secure recovery code: FORGE-XXXX-XXXX-XXXX
// Uses crypto.randomBytes instead of Math.random
function generateRecoveryCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
  const buf = randomBytes(12); // 4 bytes per segment × 3 segments
  let code = "FORGE";
  for (let seg = 0; seg < 3; seg++) {
    code += "-";
    for (let i = 0; i < 4; i++) {
      // Use modulo-rejection sampling alternative: buf byte is 0-255, chars.length=32
      // 256 is divisible by 32, so no bias
      code += chars[buf[seg * 4 + i]! % chars.length];
    }
  }
  return code;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get("/new-session", writeLimiter, (_req, res) => {
  const sessionId = randomUUID();
  const data = NewSessionResponse.parse({ sessionId });
  res.json(data);
});

router.get("/load-state", readLimiter, async (req, res) => {
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

router.post("/save-state", writeLimiter, async (req, res) => {
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

router.post("/generate-recovery", recoveryGenLimiter, async (req, res) => {
  const body = GenerateRecoveryBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { password } = body;

  try {
    const rows = await db.select().from(playersTable).where(eq(playersTable.username, username)).limit(1);
    if (rows.length === 0) {
      // Equalise timing: still run bcrypt so response time doesn't reveal account existence
      await bcrypt.compare(password, DUMMY_HASH);
      res.status(401).json({ error: "Invalid username or password.", code: "INVALID_CREDENTIALS" });
      return;
    }
    const player = rows[0];
    const passwordMatch = await bcrypt.compare(password, player.passwordHash);
    if (!passwordMatch) {
      res.status(401).json({ error: "Invalid username or password.", code: "INVALID_CREDENTIALS" });
      return;
    }

    const recoveryCode = generateRecoveryCode();
    const recoveryHash = await bcrypt.hash(recoveryCode, BCRYPT_ROUNDS);
    await db.update(playersTable).set({ recoveryHash }).where(eq(playersTable.username, username));

    const data = GenerateRecoveryResponse.parse({ recoveryCode });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to generate recovery code");
    res.status(500).json({ error: "Failed to generate recovery code. Please try again.", code: "SERVER_ERROR" });
  }
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const body = ResetPasswordBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { recoveryCode, newPassword } = body;

  try {
    const rows = await db.select().from(playersTable).where(eq(playersTable.username, username)).limit(1);

    // Always run bcrypt.compare to equalise response time regardless of whether the
    // account or recovery hash exists — prevents timing-based enumeration
    const hashToCompare = rows[0]?.recoveryHash ?? DUMMY_HASH;
    const codeMatch = await bcrypt.compare(recoveryCode.trim().toUpperCase(), hashToCompare);

    if (rows.length === 0 || !rows[0].recoveryHash || !codeMatch) {
      res.status(401).json({ error: "Invalid username or recovery code.", code: "INVALID_CREDENTIALS" });
      return;
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Clear the recovery hash so the code can only be used once
    await db.update(playersTable)
      .set({ passwordHash: newPasswordHash, recoveryHash: null })
      .where(eq(playersTable.username, username));

    const data = ResetPasswordResponse.parse({ success: true });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to reset password");
    res.status(500).json({ error: "Failed to reset password. Please try again.", code: "SERVER_ERROR" });
  }
});

const USERNAME_MAX_LENGTH = 24;
const USERNAME_PATTERN = /^[a-z0-9_-]+$/;

router.get("/check-username", lookupLimiter, async (req, res) => {
  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!username || username.length > USERNAME_MAX_LENGTH) {
    res.status(400).json({ error: "username is required and must be ≤24 characters" });
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

router.post("/register", authLimiter, async (req, res) => {
  const body = RegisterPlayerBody.parse(req.body);
  const username = body.username.trim().toLowerCase();
  const { password } = body;

  if (username.length > USERNAME_MAX_LENGTH) {
    res.status(400).json({ error: `Username must be ${USERNAME_MAX_LENGTH} characters or fewer.`, code: "INVALID_USERNAME" });
    return;
  }

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

    // Always run bcrypt.compare to equalise response time and prevent username enumeration
    const hashToCompare = rows[0]?.passwordHash ?? DUMMY_HASH;
    const passwordMatch = await bcrypt.compare(password, hashToCompare);

    if (rows.length === 0 || !passwordMatch) {
      res.status(401).json({ error: "Invalid username or password.", code: "INVALID_CREDENTIALS" });
      return;
    }

    const player = rows[0]!;
    const data = LoginPlayerResponse.parse({ sessionId: player.sessionId, username: player.username, isNewPlayer: false });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to login player");
    res.status(500).json({ error: "Login failed. Please try again.", code: "SERVER_ERROR" });
  }
});

router.get("/leaderboard", readLimiter, async (req, res) => {
  try {
    const rows = await db
      .select({
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
