import type pg from "pg";
import { appPool } from "./pool.js";

// Runs fn inside a transaction on the RLS-enforced pool with app.user_id set.
// Every RLS policy keys on this setting via app_user_households().
export async function withUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await appPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
