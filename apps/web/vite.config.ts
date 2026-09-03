import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: { "/api": "http://localhost:3011" },
  },
  // PGlite ships its Postgres WASM build as a binary sidecar file
  // (pglite.data) fetched at runtime relative to its JS bundle. Vite's
  // dependency pre-bundler (esbuild) rewrites/copies the JS into
  // node_modules/.vite/deps/ but doesn't know to carry the sidecar file
  // along, so a pre-bundled pglite.js ends up requesting a pglite.data that
  // was never copied -- the dev server's SPA fallback then serves
  // index.html for that request instead of a 404, and PGlite's loader
  // rejects it as a corrupt/truncated bundle ("Invalid FS bundle size").
  // Excluding the package from pre-bundling makes Vite serve it straight
  // from node_modules via its own resolution, where the JS and its sidecar
  // file live side by side. Matches PGlite's own Vite integration guidance.
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },
  // pglite-worker.ts (issue #17's PGliteWorker migration) is bundled as a
  // Vite `?worker` entry. Vite's default worker output format is IIFE,
  // which Rollup refuses for a build that needs code-splitting -- and this
  // one does, since the worker dynamically pulls in PGlite's own WASM/data
  // sidecar loading code the same way the main bundle does. `format: "es"`
  // (an ES module worker) is what PGlite's own Vite integration guidance
  // calls for.
  worker: {
    format: "es",
  },
});
