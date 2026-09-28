import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB } from "./config/db";
import productRoutes from "./routes/productRoutes";
import orderRoutes from "./routes/orderRoutes";
import reportRoutes from "./routes/reportRoutes";
import dashboardRoutes from "./routes/dashboardRoutes";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;

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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
