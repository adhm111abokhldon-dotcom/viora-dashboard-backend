import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import productRoutes from "./routes/productRoutes.js";
import orderRoutes from "./routes/orderRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

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
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/dashboard", dashboardRoutes);

async function startServer() {
  await connectDB();

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

// hello
