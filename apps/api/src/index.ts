import { serve } from "@hono/node-server";
import "dotenv/config";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on :${info.port}`);
});
