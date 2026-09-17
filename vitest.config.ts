import path from "node:path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(process.cwd());

export default defineConfig({
  test: {
    projects: [
      {
        // Pure unit + DB/RLS suites. The DB globalSetup belongs to this
        // project only, so component tests never need Postgres.
        resolve: { alias: { "@": repoRoot } },
        esbuild: { jsx: "automatic" },
        test: {
          name: "node",
          environment: "node",
          globalSetup: "./db/test/globalSetup.ts",
          include: ["lib/**/*.test.ts", "db/test/**/*.test.ts"],
        },
      },
      {
        // Presentational component suites run in jsdom with no globalSetup.
        // resolve/esbuild are set per project because Vitest does not
        // inherit them from the root config: Next's tsconfig uses
        // `jsx: "preserve"`, so esbuild needs the automatic JSX runtime
        // explicitly, and the `@` alias must be restated.
        resolve: { alias: { "@": repoRoot } },
        esbuild: { jsx: "automatic" },
        test: {
          name: "components",
          environment: "jsdom",
          setupFiles: "./components/test/setup.ts",
          include: ["components/**/*.test.tsx"],
        },
      },
    ],
  },
});
