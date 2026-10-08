// The sentence builder's pill popovers (desktop and phone): each pill opens an animated
// popover, the choices flow back into the sentence, the summary and the dock button.
import { test, expect, type Page } from "@playwright/test";
import { signIn, brokerLogin, headline, noHorizontalOverflow } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const pop = (page: Page) => page.getByRole("dialog");

async function inViewport(page: Page): Promise<void> {
  const b = (await pop(page).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height);
}

test("@mobile every pill opens a popover; choices update the sentence, summary and dock", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await headline(page);
  await expect(page.getByTestId("summary")).toContainText("chance of profit");

  // underlying: index list with real prices; no sparkline without real intraday data
  await page.getByRole("button", { name: "Underlying" }).click();
  await expect(pop(page)).toBeVisible();
  await inViewport(page);
  const list = page.getByTestId("pick-underlying");
  await expect(list.getByRole("button", { name: /Nifty 50/ })).toContainText(/22,4\d\d\.\d\d/);
  await expect(list.getByRole("button", { name: /Bank Nifty/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Sensex/ })).toBeVisible();
  await expect(pop(page).locator(".x-spark")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(pop(page)).toBeHidden();

  // direction: four plain phrases
  await page.getByRole("button", { name: "Direction" }).click();
  for (const p of ["stays above", "goes above", "stays below", "falls below"]) await expect(pop(page).getByRole("button", { name: new RegExp(p) })).toBeVisible();
  await inViewport(page);
  await pop(page).getByRole("button", { name: /stays below/ }).click();
  await expect(page.getByRole("button", { name: "Direction" })).toHaveText(/stays below/);
  await expect(page.getByTestId("suggestion")).toContainText("Bear call spread");

  // level: type it, see % from spot and the chance
  await page.getByRole("button", { name: "Level" }).click();
  await inViewport(page);
  await expect(pop(page).getByLabel("Level slider")).toBeVisible();
  await page.getByLabel("Level value").fill("22600");
  await page.getByLabel("Level value").press("Enter");
  await expect(page.getByRole("button", { name: "Level" })).toContainText("22,600");
  await expect(page.getByRole("button", { name: "Level" })).toContainText("↑0.7%");
  await page.getByRole("button", { name: "Level" }).click();
  await expect(page.locator("#popInfo")).toContainText(/↑0\.7% from spot · \d+% chance it settles below/);
  await page.keyboard.press("Escape");

  // expiry: weekly/monthly tags, days left, a chance per expiry (or "no prices")
  await page.getByRole("button", { name: "Expiry" }).click();
  await inViewport(page);
  await expect(pop(page).getByRole("button", { name: /13 Oct/ })).toContainText(/5 days · weekly/);
  await expect(pop(page).getByRole("button", { name: /27 Oct/ })).toContainText(/monthly\s*\d+%/);
  await pop(page).getByRole("button", { name: /27 Oct/ }).click();
  await expect(page.getByRole("button", { name: "Expiry" })).toHaveText(/Tue 27 Oct/);

  // risk: type it; the summary and the dock button follow
  await page.getByRole("button", { name: "Amount you are risking in rupees" }).click();
  await inViewport(page);
  await expect(pop(page).getByLabel("Amount slider")).toBeVisible();
  await page.getByLabel("Amount value").fill("12,000");
  await page.getByLabel("Amount value").press("Enter");
  await expect(page.getByRole("button", { name: "Amount you are risking in rupees" })).toContainText("₹12,000");
  await expect(page.getByTestId("dock-primary")).toContainText("Review for ₹");
  const risk = Number((await page.locator("#qCost").textContent())!.replace(/[^\d]/g, ""));
  expect(risk).toBeGreaterThan(0);
  expect(risk).toBeLessThanOrEqual(12000);
  await noHorizontalOverflow(page);

  // switching the underlying resets the level to one near the new spot
  await page.getByRole("button", { name: "Underlying" }).click();
  await page.getByTestId("pick-underlying").getByRole("button", { name: /Bank Nifty/ }).click();
  await expect(page.getByRole("button", { name: "Underlying" })).toHaveText(/Bank Nifty/);
  await expect(page.getByTestId("spot")).toHaveText(/54,8\d\d/);
  await expect(page.getByRole("button", { name: "Level" })).toContainText(/5[45],\d{3}/);
});

test("popover closes on outside click and on Escape, and returns focus", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await headline(page);
  await page.getByRole("button", { name: "Direction" }).click();
  await expect(pop(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Direction" })).toHaveAttribute("aria-expanded", "true");
  await page.mouse.click(5, 5);
  await expect(pop(page)).toBeHidden();
  await page.getByRole("button", { name: "Level" }).click();
  await page.keyboard.press("Escape");
  await expect(pop(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Level" })).toBeFocused();
});
