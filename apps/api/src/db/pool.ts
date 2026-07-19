import pg from "pg";
import "dotenv/config";

// Privileged: migrations, better-auth, service ops (household create, invite accept).
export const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// RLS-enforced: all tenant data access. Lazily created so the migrator can run
// before the taakify_app role exists.
let _appPool: pg.Pool | undefined;
export function appPool(): pg.Pool {
  _appPool ??= new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
  return _appPool;
}
