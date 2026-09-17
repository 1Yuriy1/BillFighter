import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(process.cwd()),
    },
  },
  test: {
    environment: "node",
    globalSetup: "./db/test/globalSetup.ts",
    include: ["lib/**/*.test.ts", "db/test/**/*.test.ts"],
  },
});
