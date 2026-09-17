const { chromium } = require("playwright");
const path = require("path");

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const OUT = "/home/user/work/evidence";

async function signIn(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("heading", { level: 1 })
    .filter({ hasText: /E2E Family|Staff console/ })
    .waitFor({ timeout: 15_000 });
}

(async () => {
  const browser = await chromium.launch();

  // tc-3: interactive family flow — login form → dashboard with the resolved case
  const familyCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const familyPage = await familyCtx.newPage();
  await familyPage.goto(`${BASE}/login`);
  await familyPage.getByLabel("Email").fill("e2e-family@billfighter.test");
  await familyPage.getByRole("button", { name: "Sign in" }).click();
  await familyPage
    .getByRole("heading", { name: "Meridian Health Plan — St. Augustine Hospital" })
    .waitFor({ timeout: 15_000 });
  await familyPage
    .getByRole("heading", { name: /CASE TIMELINE|Timeline/i })
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  await familyPage.waitForTimeout(2_000); // settle final frames
  await familyPage.screenshot({ path: path.join(OUT, "tc-1-family-dashboard.png") });
  await familyCtx.close();

  // tc-2: staff console — urgent-first review queue
  const staffCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const staffPage = await staffCtx.newPage();
  await signIn(staffPage, "e2e-staff@billfighter.test");
  await staffPage.goto(`${BASE}/staff`);
  await staffPage.getByRole("heading", { name: "Staff console" }).waitFor({ timeout: 15_000 });
  await staffPage.waitForTimeout(1_000);
  await staffPage.screenshot({ path: path.join(OUT, "tc-2-staff-console.png") });
  await staffCtx.close();

  await browser.close();
  console.log("captured");
})();
