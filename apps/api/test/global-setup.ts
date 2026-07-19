import pg from "pg";
import { migrate } from "../src/db/migrate.js";

const ADMIN = "postgresql://postgres:postgres@localhost:5433";
const TEST_DB_URL = `${ADMIN}/taakify_test`;

export default async function setup() {
  const root = new pg.Pool({ connectionString: `${ADMIN}/postgres` });
  const { rowCount } = await root.query("SELECT 1 FROM pg_database WHERE datname = 'taakify_test'");
  if (!rowCount) await root.query("CREATE DATABASE taakify_test");
  await root.end();

  const db = new pg.Pool({ connectionString: TEST_DB_URL });
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.end();

  await migrate(TEST_DB_URL);
}
