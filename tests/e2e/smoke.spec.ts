import { expect, test } from "@playwright/test";

test("home page renders the product", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "BillFighter" })).toBeVisible();
});
