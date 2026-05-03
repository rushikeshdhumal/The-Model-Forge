import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
