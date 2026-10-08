// Category switching in the underlying popover: indices, F&O stocks, MCX metals and energy,
// NSE currency. Prices come from the recorded public data behind the mock broker (NSE chains
// and the mcxindia.com MCX option chains of 8 Oct 2026); currency has no recorded prices.
import { test, expect, type Page } from "@playwright/test";
import { signIn, brokerLogin, setMode, tab, noHorizontalOverflow } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const pop = (page: Page) => page.getByRole("dialog");

async function pick(page: Page, cat: string, name: RegExp): Promise<void> {
  await page.getByRole("button", { name: "Underlying" }).click();
  await pop(page).getByRole("group", { name: "Category" }).getByRole("button", { name: cat }).click();
  await expect(pop(page).getByRole("group", { name: "Category" }).getByRole("button", { name: cat })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pick-underlying").getByRole("button", { name }).first().click();
  await expect(pop(page)).toBeHidden();
}

async function setRisk(page: Page, v: string): Promise<void> {
  await page.getByRole("button", { name: "Amount you are risking in rupees" }).click();
  await page.getByLabel("Amount value").fill(v);
  await page.getByLabel("Amount value").press("Enter");
}

test("@mobile the picker has a category switch with a coloured dot per category", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await tab(page, "Options");
  await page.getByRole("button", { name: "Underlying" }).click();
  const seg = pop(page).getByRole("group", { name: "Category" });
  for (const c of ["Indices", "Stocks", "Metals", "Energy", "Currency"]) await expect(seg.getByRole("button", { name: c })).toHaveCount(1);
  await expect(seg.getByRole("button", { name: "Indices" })).toHaveAttribute("aria-pressed", "true");
  // all five fit inside the popover (none scrolled out of sight on a phone)
  const pb = (await pop(page).boundingBox())!;
  for (const c of ["Indices", "Stocks", "Metals", "Energy", "Currency"]) {
    const bb = (await seg.getByRole("button", { name: c }).boundingBox())!;
    expect(bb.x).toBeGreaterThanOrEqual(pb.x);
    expect(bb.x + bb.width).toBeLessThanOrEqual(pb.x + pb.width);
  }
  await expect(seg.locator(".x-dot.x-cat--metal")).toHaveCount(1);
  await expect(page.getByTestId("pick-underlying").getByRole("button", { name: /Bank Nifty/ })).toBeVisible();
  await seg.getByRole("button", { name: "Metals" }).click();
  const list = page.getByTestId("pick-underlying");
  await expect(list.getByRole("button", { name: /^Gold\b/ }).first()).toContainText("lot ×100");
  await expect(list.getByRole("button", { name: /Aluminium/ })).toContainText("futures only");
  await expect(list.getByRole("button", { name: /Bank Nifty/ })).toHaveCount(0);
  await seg.getByRole("button", { name: "Energy" }).click();
  await expect(list.getByRole("button", { name: /Crude Mini/ })).toContainText("lot ×10");
  await seg.getByRole("button", { name: "Currency" }).click();
  await expect(list.getByRole("button", { name: /USD\/INR/ })).toContainText("lot ×1000");
  await noHorizontalOverflow(page);
  await page.keyboard.press("Escape");
});

test("MCX: hours per segment, options strategy on commodity options, paper only, review and fill", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Paper");
  await tab(page, "Options");
  await pick(page, "Energy", /Crude Mini/);
  await expect(page.getByRole("button", { name: "Underlying" })).toHaveText(/Crude Mini/);
  // per-segment hours: MCX runs to 23:30 in October (US daylight saving)
  await expect(page.getByTestId("market-chip")).toHaveText("MCX open till 23:30");
  await expect(page.getByTestId("chain-meta")).toContainText("Live");
  await expect(page.getByTestId("spot")).toHaveText("8,985.00"); // the recorded CRUDEOILM FUT 19 OCT 26 price
  await setRisk(page, "20000");
  await expect(page.getByTestId("suggestion")).toContainText("CRUDEOILM");
  // live is switched off for commodities, with the reason on the button
  const live = page.getByRole("group", { name: "Trading mode" }).getByRole("button", { name: "Live" });
  await expect(live).toBeDisabled();
  await expect(live).toHaveAttribute("title", /UDAPI1161/);
  await page.getByTestId("dock-primary").click();
  await expect(page.getByTestId("review-title")).toContainText("PAPER");
  await expect(page.getByText("23:30 IST (MCX close)")).toBeVisible();
  await expect(page.getByText(/devolves into the future/)).toBeVisible();
  await page.getByLabel(/I understand I can lose/).check();
  await page.getByTestId("place").click();
  await expect(page.getByTestId("result")).toContainText("Paper · Filled");
  await page.getByRole("button", { name: "See portfolio" }).click();
  await expect(page.getByTestId("position").filter({ hasText: "CRUDEOILM" })).toHaveCount(2);
});

test("futures-only commodities say so; currency without prices says so", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await tab(page, "Options");
  await pick(page, "Metals", /Aluminium/);
  await expect(page.getByTestId("no-prices")).toContainText("futures only");
  await expect(page.locator("#kindTag")).toHaveText("Futures only");
  await expect(page.locator(".x-futs")).toContainText("ALUMINIUM FUT 30 OCT 26");
  await expect(page.getByTestId("dock-primary")).toBeDisabled();
  await pick(page, "Currency", /USD\/INR/);
  await expect(page.getByTestId("market-chip")).toHaveText("Currency open till 17:00");
  await expect(page.getByTestId("chain-meta")).toContainText("Prices unavailable");
  await expect(page.getByTestId("dock-primary")).toBeDisabled();
  // back to an index: NSE hours again
  await pick(page, "Indices", /Nifty 50/);
  await expect(page.getByTestId("market-chip")).toHaveText("Market open");
});

test("@mobile the stocks tab has the same category picker for cash equity", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await tab(page, "Stocks");
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  const seg = pop(page).getByRole("group", { name: "Category" });
  await expect(seg.getByRole("button", { name: "F&O stocks" })).toHaveAttribute("aria-pressed", "true");
  await expect(pop(page).getByRole("button", { name: /Reliance/i }).first()).toBeVisible();
  await seg.getByRole("button", { name: "All NSE" }).click();
  await pop(page).getByLabel("Search stocks").fill("TCS");
  await expect(pop(page).getByRole("button", { name: /TCS/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
});
