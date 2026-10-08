import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import productRoutes from "./routes/productRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import advertisingRoutes from "./routes/advertisingRoutes.js";
import productStatsRoutes from "./routes/productStatsRoutes.js";
import {
  assertBusinessNumbersComplete,
  ensureBusinessNumberCounters,
} from "./lib/orderNumber.js";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const frontendOriginConfig = process.env.FRONTEND_URL?.trim();
if (process.env.NODE_ENV === "production" && !frontendOriginConfig) {
  throw new Error("FRONTEND_URL must be configured in production");
}
const frontendOrigins = (frontendOriginConfig ?? "http://localhost:3000")
  .split(",")
  .map((value) => {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    ) {
      throw new Error("FRONTEND_URL must contain valid HTTPS origins");
    }
    return url.origin;
  });
const allowedOrigins = new Set(frontendOrigins);

app.use(
  cors({
    origin(origin, callback) {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    message: "Viora Beauty API is running",
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
  });
});

app.use("/api", (req, res, next) => {
  const origin = req.get("origin");
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);

  const isProduction = process.env.NODE_ENV === "production";
  if (
    isMutation &&
    ((!origin && isProduction) || (origin && !allowedOrigins.has(origin)))
  ) {
    res.status(403).json({ message: "Request origin is not allowed" });
    return;
  }

  next();
});

app.use("/api/products", productRoutes);
// "/api/products/:id/stats" has two segments, so productRoutes' single-segment
// "/:id" handler cannot swallow it; Express simply falls through.
app.use("/api/products", productStatsRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/advertising", advertisingRoutes);

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    console.error("Unhandled request error:", error);
    const isInvalidJson =
      error instanceof SyntaxError &&
      "status" in error &&
      error.status === 400;
    res
      .status(isInvalidJson ? 400 : 500)
      .json({ message: isInvalidJson ? "Invalid JSON request body" : "Internal server error" });
  },
);

async function startServer() {
  await connectDB();
  await assertBusinessNumbersComplete();
  await ensureBusinessNumberCounters();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API base: http://localhost:${PORT}/api`);
  });

  /*
   * If another instance already holds the port, the old process would keep
   * serving stale code while the new one silently does nothing. Fail loudly
   * instead so the shadowed server is impossible to miss.
   */
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — another backend instance is running ` +
          `and would serve stale code. Stop it (e.g. kill the process using ` +
          `port ${PORT}) and restart.`,
      );
    } else {
      console.error("Server failed to start:", error);
    }

    process.exit(1);
  });
}

startServer();
