import { createMiddleware } from "hono/factory";
import { auth } from "../auth.js";

export type SessionUser = { id: string; email: string; name: string };

export const requireUser = createMiddleware<{ Variables: { user: SessionUser } }>(
  async (c, next) => {
    let session: Awaited<ReturnType<typeof auth.api.getSession>> = null;
    try {
      session = await auth.api.getSession({ headers: c.req.raw.headers });
    } catch {
      // Malformed cookie or transient auth-store failure — treat as no session.
    }
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("user", session.user as SessionUser);
    await next();
  }
);
