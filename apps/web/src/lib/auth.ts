import { createAuthClient } from "better-auth/react";

// Same origin in dev (vite proxy) and prod (nginx) — no baseURL needed
// beyond the path prefix.
export const authClient = createAuthClient({ basePath: "/api/auth" });
