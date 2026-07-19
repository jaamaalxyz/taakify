import type { Hono } from "hono";
import { randomUUID } from "node:crypto";

// Signs up a fresh user via the real auth endpoint; returns its session cookie.
export async function signUp(
  app: Hono,
  email = `${randomUUID()}@test.local`
): Promise<{ cookie: string; email: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", name: "Test User" }),
  });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie();
  if (cookies.length === 0) throw new Error("no session cookie returned");
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  return { cookie, email };
}
