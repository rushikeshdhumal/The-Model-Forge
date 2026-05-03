import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust exactly one hop of reverse-proxy so rate-limiter gets the real client IP
// (Replit routes traffic through a shared proxy)
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// CORS — only allow requests from the same Replit domain (or localhost in dev)
const allowedOrigins = (() => {
  const domains = process.env["REPLIT_DOMAINS"];
  if (domains) {
    return domains.split(",").map((d) => `https://${d.trim()}`);
  }
  // Development fallback — same-origin requests via the shared proxy at localhost:80
  return ["http://localhost:80", "http://localhost"];
})();

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin requests (no Origin header) and matching domains
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Limit request body size to 128 KB to prevent payload flooding
app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: true, limit: "128kb" }));

app.use("/api", router);

// Global error handler — catches ZodErrors and other thrown errors, returns clean JSON
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    const message = err.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    res.status(400).json({ error: message, code: "VALIDATION_ERROR" });
    return;
  }
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "An unexpected error occurred.", code: "SERVER_ERROR" });
});

export default app;
