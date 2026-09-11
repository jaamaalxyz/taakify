import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import "dotenv/config";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(
  databaseUrl: string,
  options?: { appDbPassword?: string }
): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (rowCount) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    // Runs on every invocation (not just when 0003_rls.sql is newly applied)
    // so that re-running `pnpm migrate` after rotating APP_DB_PASSWORD picks
    // up the new value. migrations/0003_rls.sql still bootstraps the role
    // with a hardcoded dev password on first-ever creation (CREATE ROLE ...
    // IF NOT EXISTS) -- this always overrides it via quote-escaped ALTER ROLE
    // (Postgres's DDL grammar doesn't accept a bind parameter in PASSWORD's clause;
    // the value is single-quote-doubled before interpolation, safe here since it
    // only ever comes from an operator-set env var, never user input).
    const { rowCount: roleExists } = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = 'taakify_app'"
    );
    if (roleExists) {
      const appDbPassword = options?.appDbPassword ?? "taakify_app_dev";
      const escapedPassword = appDbPassword.replace(/'/g, "''");
      await pool.query(`ALTER ROLE taakify_app WITH PASSWORD '${escapedPassword}'`);
    }
  } finally {
    await pool.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(process.env.DATABASE_URL, { appDbPassword: process.env.APP_DB_PASSWORD })
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Up to date");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
