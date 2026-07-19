import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./test/global-setup.ts",
    setupFiles: ["./test/env-setup.ts"],
    fileParallelism: false, // tests share one database
    testTimeout: 15000,
  },
});
