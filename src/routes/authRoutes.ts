import { Router } from "express";
import { z } from "zod";
import {
  checkLoginLimit,
  clearFailedLogins,
  clearSessionCookie,
  createSessionCookie,
  credentialsMatch,
  isAuthenticated,
  recordFailedLogin,
} from "../lib/auth.js";

const router = Router();

const loginSchema = z.object({
  username: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
});

router.post("/login", (request, response) => {
  const client = request.ip || request.socket.remoteAddress || "unknown";

  if (checkLoginLimit(client, response)) return;

  const result = loginSchema.safeParse(request.body);
  if (!result.success) {
    response.status(400).json({ message: "Username and password are required" });
    return;
  }

  try {
    if (!credentialsMatch(result.data.username, result.data.password)) {
      const retryAfter = recordFailedLogin(client);

      if (retryAfter > 0) {
        response.status(401).json({ message: "Invalid username or password" });
      }
      return;
    }

    clearFailedLogins(client);
    response.setHeader("Set-Cookie", createSessionCookie());
    response.status(200).json({ username: result.data.username.trim() });
  } catch (error) {
    console.error("Login failed because authentication is unavailable:", error);
    response.status(503).json({ message: "Authentication is not configured" });
  }
});

router.get("/session", (request, response) => {
  try {
    if (!isAuthenticated(request)) {
      response.status(401).json({ message: "Authentication required" });
      return;
    }

    response.status(200).json({ authenticated: true });
  } catch (error) {
    console.error("Session validation failed:", error);
    response.status(503).json({ message: "Authentication is not configured" });
  }
});

router.post("/logout", (_request, response) => {
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.status(204).end();
});

export default router;
