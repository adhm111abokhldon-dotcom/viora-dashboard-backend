import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionCookie,
  credentialsMatch,
  isAuthenticated,
} from "./auth.js";

test("case-insensitive login credentials create a valid canonical session", () => {
  const previous = {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
    secret: process.env.SESSION_SECRET,
  };

  process.env.ADMIN_USERNAME = "Administrator";
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.SESSION_SECRET = "a".repeat(32);

  try {
    assert.equal(credentialsMatch(" administrator ", "test-password"), true);

    const cookie = createSessionCookie().split(";")[0];
    const request = {
      get: (name: string) => (name.toLowerCase() === "cookie" ? cookie : undefined),
    };

    assert.equal(isAuthenticated(request), true);
  } finally {
    if (previous.username === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previous.username;
    if (previous.password === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous.password;
    if (previous.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.secret;
  }
});
