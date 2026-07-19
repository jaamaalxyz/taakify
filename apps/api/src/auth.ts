import { betterAuth } from "better-auth";
import { adminPool } from "./db/pool.js";

const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (!process.env.BETTER_AUTH_SECRET) {
  // better-auth silently falls back to a well-known dev secret — never allow that.
  throw new Error("BETTER_AUTH_SECRET is not set");
}

export const auth = betterAuth({
  database: adminPool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  emailAndPassword: { enabled: true },
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : undefined,
  trustedOrigins: ["http://localhost:5173"],
});
