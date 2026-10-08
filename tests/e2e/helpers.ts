import { expect, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:18781";
export const PASS = "e2e passphrase 123";
export const HEADLINE = "I think Nifty stays above 22,300 till Tuesday's expiry, risking ₹5,000";

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

export async function headline(page: Page, text = HEADLINE): Promise<void> {
  await page.getByRole("tab", { name: "Options" }).click();
  await page.getByLabel("Your view in plain English").fill(text);
  await page.getByRole("button", { name: "Read it" }).click();
}
