import { defineConfig, devices } from "@playwright/test";

/**
 * The E2E harness runs the full pipeline against a production build of the
 * app with every external provider pointed at the local mock server
 * (scripts/mock-providers.mjs) through the base-URL overrides — CI needs no
 * live Anthropic, Postmark, or Stripe credentials. POSTMARK_WEBHOOK_SECRET is
 * deliberately the same value the spec uses to sign its inbound-webhook
 * request; the pipeline spec reads it from the environment.
 */
const MOCK_PORT = Number(process.env.MOCK_PROVIDERS_PORT ?? 9310);
const MOCK_BASE = `http://localhost:${MOCK_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
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
  webServer: [
    {
      command: "node scripts/mock-providers.mjs",
      url: `${MOCK_BASE}/__outbox`,
      reuseExistingServer: true,
      timeout: 15_000,
    },
    {
      command: "npm run start",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        ANTHROPIC_BASE_URL: `${MOCK_BASE}/anthropic/v1/messages`,
        POSTMARK_BASE_URL: `${MOCK_BASE}/postmark/email`,
        STRIPE_BASE_URL: `${MOCK_BASE}/stripe/v1`,
        ANTHROPIC_API_KEY: "mock-anthropic-key",
        POSTMARK_SERVER_TOKEN: "mock-postmark-token",
        POSTMARK_WEBHOOK_SECRET: "e2e-webhook-secret",
        STRIPE_SECRET_KEY: "sk_test_e2e_mock_key",
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgres://postgres:postgres@localhost:5432/billfighter_test",
      },
    },
  ],
});
