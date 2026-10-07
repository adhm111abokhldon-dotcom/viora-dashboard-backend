import {
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SESSION_COOKIE = "viora_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;

type AuthConfig = {
  username: string;
  password: string;
  secret: string;
};

type SessionPayload = {
  username: string;
  expiresAt: number;
};

type CookieRequest = {
  get(name: string): string | undefined;
};

function getAuthConfig(): AuthConfig {
  const { ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET } = process.env;

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !SESSION_SECRET) {
    throw new Error(
      "ADMIN_USERNAME, ADMIN_PASSWORD, and SESSION_SECRET must be configured",
    );
  }

  if (SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }

  return {
    username: ADMIN_USERNAME.trim(),
    password: ADMIN_PASSWORD,
    secret: SESSION_SECRET,
  };
}

export function assertAuthConfiguration(): void {
  getAuthConfig();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function credentialsMatch(username: string, password: string): boolean {
  const config = getAuthConfig();
  const usernameMatches = safeEqual(
    Buffer.from(username.trim().toLowerCase()),
    Buffer.from(config.username.toLowerCase()),
  );
  const suppliedPassword = scryptSync(password, config.secret, 64);
  const expectedPassword = scryptSync(config.password, config.secret, 64);

  return usernameMatches && timingSafeEqual(suppliedPassword, expectedPassword);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookie(): string {
  const config = getAuthConfig();
  const payload = Buffer.from(
    JSON.stringify({
      username: config.username,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    } satisfies SessionPayload),
  ).toString("base64url");
  const token = `${payload}.${sign(payload, config.secret)}`;
  const secure = process.env.NODE_ENV === "production";
  const sameSite = secure ? "None" : "Lax";

  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/api",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production";
  const sameSite = secure ? "None" : "Lax";

  return [
    `${SESSION_COOKIE}=`,
    "Path=/api",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function sessionUsername(request: CookieRequest): string | null {
  const config = getAuthConfig();
  const cookie = request
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (!cookie) return null;

  const [payload, signature, extra] = cookie.split(".");
  if (!payload || !signature || extra) return null;

  const expected = Buffer.from(sign(payload, config.secret));
  const actual = Buffer.from(signature);
  if (!safeEqual(expected, actual)) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;

    if (
      decoded.username !== config.username ||
      typeof decoded.expiresAt !== "number" ||
      decoded.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return decoded.username;
  } catch {
    return null;
  }
}

export function isAuthenticated(request: CookieRequest): boolean {
  return sessionUsername(request) !== null;
}

export function requireAuthentication(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  try {
    if (sessionUsername(request)) {
      next();
      return;
    }

    response.status(401).json({ message: "Authentication required" });
  } catch (error) {
    console.error("Authentication is unavailable:", error);
    response.status(503).json({ message: "Authentication is not configured" });
  }
}

type LoginAttempt = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_TRACKED_CLIENTS = 10_000;

function isRateLimited(client: string): boolean {
  const now = Date.now();
  const attempt = loginAttempts.get(client);

  if (!attempt || attempt.resetAt <= now) {
    loginAttempts.set(client, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }

  return attempt.count >= MAX_LOGIN_ATTEMPTS;
}

export function recordFailedLogin(client: string): number {
  const now = Date.now();
  const current = loginAttempts.get(client);
  const attempt =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + LOGIN_WINDOW_MS }
      : current;

  attempt.count += 1;
  loginAttempts.set(client, attempt);

  if (loginAttempts.size > MAX_TRACKED_CLIENTS) {
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= now) loginAttempts.delete(key);
    }

    while (loginAttempts.size > MAX_TRACKED_CLIENTS) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest === undefined) break;
      loginAttempts.delete(oldest);
    }
  }

  return Math.max(1, Math.ceil((attempt.resetAt - now) / 1000));
}

export function clearFailedLogins(client: string): void {
  loginAttempts.delete(client);
}

export function checkLoginLimit(
  client: string,
  response: Response,
): boolean {
  if (!isRateLimited(client)) return false;

  const attempt = loginAttempts.get(client);
  response.setHeader(
    "Retry-After",
    String(Math.max(1, Math.ceil(((attempt?.resetAt ?? Date.now()) - Date.now()) / 1000))),
  );
  response.status(429).json({ message: "Too many login attempts" });
  return true;
}
