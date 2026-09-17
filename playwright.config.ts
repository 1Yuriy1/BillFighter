import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal for now: one smoke spec against a production build of the app.
 * CI builds, starts the server, and runs the spec against it.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
