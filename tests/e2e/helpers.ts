import { expect, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:18781";
export const PASS = "e2e passphrase 123";
export const HEADLINE = "I think Nifty stays above 22,300 till Tuesday's expiry, risking ₹5,000";
export const DEMO_LABEL = "DEMO · recorded prices from 8 Oct 2026 · no broker, no orders";

export async function resetMock(): Promise<void> {
  await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
}
export async function mockState(): Promise<{ orders: { transaction_type: string; order_type: string; validity: string; filled_quantity: number; instrument_token: string }[]; requests: { path: string }[] }> {
  return (await fetch(`${MOCK}/__mock/state`)).json();
}

export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Gateway passphrase").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("market-chip")).toBeVisible();
}

export async function brokerLogin(page: Page): Promise<void> {
  const chip = page.getByTestId("broker-chip");
  if ((await chip.textContent())?.includes("Log in")) {
    await chip.click();
    await expect(page.getByTestId("broker-chip")).toContainText("MOCK01");
  }
}

export async function setMode(page: Page, mode: "Paper" | "Live"): Promise<void> {
  await page.getByRole("group", { name: "Trading mode" }).getByRole("button", { name: mode }).click();
  await expect(page.getByTestId(mode === "Live" ? "live-banner" : "paper-banner")).toBeVisible();
}

export async function tab(page: Page, name: "Options" | "Stocks" | "Portfolio" | "Orders" | "Safety"): Promise<void> {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

/** Type a view into the plain-English box on the Options tab. */
export async function headline(page: Page, text = HEADLINE): Promise<void> {
  await tab(page, "Options");
  await page.getByLabel("Your view in plain English").fill(text);
  await page.getByRole("button", { name: "Read it" }).click();
}

/** Open the review screen from the dock's primary button. */
export async function review(page: Page): Promise<void> {
  const btn = page.getByTestId("dock-primary");
  await expect(btn).toBeEnabled();
  await expect(btn).toContainText("Review for ₹");
  await btn.click();
  await expect(page.getByTestId("review-title")).toBeVisible();
}

/** Nothing on the page is wider than the viewport (no sideways scrolling on phones). */
export async function noHorizontalOverflow(page: Page): Promise<void> {
  const [sw, vw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(vw);
}
