import { test, expect } from "@playwright/test";
import { signIn, brokerLogin, setMode, headline, review, tab, resetMock, mockState, noHorizontalOverflow, PASS } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("wrong passphrase is refused", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Gateway passphrase").fill("wrong-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong passphrase")).toBeVisible();
  await page.getByLabel("Gateway passphrase").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("paper-banner")).toBeVisible();
});

test("before broker login: no prices, no trades, honest message", async ({ page }) => {
  await signIn(page);
  if (!(await page.getByTestId("broker-chip").textContent())?.includes("Log in")) {
    // a reused gateway may still hold yesterday's session: log out of the broker first
    await tab(page, "Safety");
    await page.getByRole("button", { name: "Log out of broker" }).click();
  }
  await expect(page.getByTestId("broker-chip")).toContainText("Log in to Upstox");
  await expect(page.getByTestId("market-chip")).toContainText("Market open");
  await headline(page);
  await expect(page.getByTestId("chain-meta")).toContainText("Prices unavailable");
  await expect(page.getByTestId("no-prices")).toContainText("Log in to Upstox");
  await expect(page.getByTestId("suggestion")).toHaveCount(0);
  await expect(page.getByTestId("dock-primary")).toBeDisabled();
  // the underlying picker says why there are no prices instead of showing any
  await page.getByRole("button", { name: "Underlying" }).click();
  await expect(page.getByRole("dialog")).toContainText("Log in to Upstox");
  await page.keyboard.press("Escape");
  // the live mode button is disabled until the broker is connected
  await expect(page.getByRole("group", { name: "Trading mode" }).getByRole("button", { name: "Live" })).toBeDisabled();
});

test("the parser reports what it could not read", async ({ page }) => {
  await signIn(page);
  await headline(page, "nifty goes up");
  await expect(page.locator(".note").first()).toContainText("the level");
});

test("headline sentence → bull put spread → review → paper trade fills against live quotes", async ({ page }) => {
  await resetMock();
  await signIn(page);
  await brokerLogin(page);
  await tab(page, "Portfolio");
  await page.getByRole("button", { name: "Reset paper book" }).click();
  await expect(page.getByTestId("positions-empty")).toBeVisible();
  await headline(page);
  await expect(page.getByTestId("chain-meta")).toContainText("Live");
  await expect(page.getByTestId("spot")).toHaveText(/22,4\d\d/);
  const sug = page.getByTestId("suggestion");
  await expect(sug).toContainText("Bull put spread");
  await expect(sug).toContainText("SELL");
  await expect(sug).toContainText("22300 PE");
  await expect(page.getByTestId("summary")).toContainText(/It risks ₹[\d,]+ · \d+% chance of profit/);
  const maxLoss = Number((await sug.getByTestId("max-loss").textContent())!.replace(/[^\d.]/g, ""));
  expect(maxLoss).toBeLessThanOrEqual(5000);
  await review(page);
  await expect(page.getByTestId("review-title")).toContainText("PAPER");
  await expect(page.getByRole("heading", { name: /Make ₹[\d,]+ if Nifty 50 stays above 22,300 by Tue 13 Oct/ })).toBeVisible();
  await expect(page.locator(".x-out")).toHaveCount(3);
  await expect(page.locator("#chart rect")).toHaveCount(15);
  await page.locator("#chart rect").nth(12).hover();
  await expect(page.locator("#tip")).toContainText("Nifty 50");
  await page.getByText("Contracts").click();
  await expect(page.getByTestId("legs").locator("tbody tr")).toHaveCount(2);
  await expect(page.getByTestId("charges-total")).toHaveText(/₹\d+\.\d\d/);
  await expect(page.getByTestId("broker-charges")).toHaveText(/₹\d+\.\d\d/);
  await expect(page.locator("[data-margin]")).toContainText("hedged");
  const place = page.getByTestId("place");
  await expect(place).toBeDisabled();
  await page.getByLabel(/I understand I can lose/).check();
  await expect(place).toBeEnabled();
  await expect(place).toContainText("Place paper trade");
  await place.click();
  await expect(page.getByTestId("result")).toContainText("Paper · Filled");
  expect((await mockState()).orders).toHaveLength(0); // nothing reached the broker
  await page.getByRole("button", { name: "See portfolio" }).click();
  await expect(page.getByRole("heading", { name: /Paper portfolio/ })).toBeVisible();
  await expect(page.getByTestId("position")).toHaveCount(2);
});

test("live trade needs the typed REAL MONEY phrase; legs go buy-first as IOC limits", async ({ page }) => {
  await resetMock();
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Live");
  await headline(page);
  await review(page);
  await expect(page.getByTestId("review-title")).toContainText("REAL MONEY");
  await page.getByLabel(/I understand I can lose/).check();
  const place = page.getByTestId("place");
  await expect(place).toBeDisabled();
  await page.getByTestId("phrase").fill("real mon");
  await expect(place).toBeDisabled();
  await page.getByTestId("phrase").fill("REAL MONEY");
  await expect(place).toBeEnabled();
  await expect(place).toContainText("Send real order");
  await place.click();
  await expect(page.getByTestId("result")).toContainText("Filled");
  const st = await mockState();
  expect(st.orders.map((o) => [o.transaction_type, o.order_type, o.validity])).toEqual([["BUY", "LIMIT", "IOC"], ["SELL", "LIMIT", "IOC"]]);
});

test("kill switch blocks new trades; Exit all closes live positions with limit orders", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Live");
  await tab(page, "Safety");
  await page.getByTestId("kill-toggle").check();
  await expect(page.getByTestId("kill-chip")).toBeVisible();
  await headline(page);
  await review(page);
  await expect(page.getByText("Kill switch is on")).toBeVisible();
  await page.getByLabel(/I understand I can lose/).check();
  await page.getByTestId("phrase").fill("REAL MONEY");
  await expect(page.getByTestId("place")).toBeDisabled();
  await page.getByRole("button", { name: "Edit" }).click();
  await tab(page, "Safety");
  await page.getByTestId("exit-phrase").fill("EXIT ALL");
  await page.getByTestId("exit-all").click();
  await expect(page.getByTestId("exit-result")).toContainText("closed");
  const net: Record<string, number> = {};
  for (const o of (await mockState()).orders) net[o.instrument_token] = (net[o.instrument_token] ?? 0) + (o.transaction_type === "BUY" ? 1 : -1) * o.filled_quantity;
  expect(Object.values(net).every((q) => q === 0)).toBe(true);
  expect((await mockState()).orders.every((o) => o.order_type === "LIMIT")).toBe(true);
  await page.getByTestId("kill-toggle").uncheck();
  await expect(page.getByTestId("kill-chip")).toHaveCount(0);
});

test("Cancel all is on the Safety tab and answers for the current mode", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Paper");
  await tab(page, "Safety");
  await page.getByTestId("cancel-all").click();
  await expect(page.locator("#killRes")).toContainText("Cancelled");
});

test("optional caps: off by default, a per-trade cap blocks a bigger trade", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Paper");
  await tab(page, "Safety");
  await expect(page.getByTestId("cap-trade")).toHaveValue("");
  await expect(page.getByTestId("cap-day")).toHaveValue("");
  await page.getByTestId("cap-trade").fill("1000");
  await page.getByRole("button", { name: "Save" }).click();
  await headline(page);
  await review(page);
  await expect(page.getByText(/Above your per-trade cap/)).toBeVisible();
  await page.getByLabel(/I understand I can lose/).check();
  await expect(page.getByTestId("place")).toBeDisabled();
  await page.getByRole("button", { name: "Edit" }).click();
  await tab(page, "Safety");
  await page.getByTestId("cap-trade").fill("");
  await page.getByRole("button", { name: "Save" }).click();
});

test("stocks: 'buy ₹20,000 of Reliance' → whole shares at a limit, with charges, paper order", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await setMode(page, "Paper");
  await tab(page, "Stocks");
  await page.getByLabel("Stock order in plain English").fill("buy ₹20,000 of Reliance");
  await page.getByRole("button", { name: "Read it" }).click();
  const t = page.getByTestId("eq-ticket");
  await expect(t).toContainText("Buy 16 RELIANCE");
  await expect(t).toContainText("Delivery");
  await expect(page.getByRole("button", { name: "How much" })).toContainText("₹20,000");
  await t.getByRole("button", { name: "Place paper order" }).click();
  await expect(t).toContainText("Paper order placed");
});

test("stocks sentence pills: amount and stock picker update the ticket", async ({ page }) => {
  await signIn(page);
  await brokerLogin(page);
  await tab(page, "Stocks");
  await expect(page.getByTestId("eq-ticket")).toBeVisible();
  await page.getByRole("button", { name: "How much" }).click();
  await page.getByLabel("Size value").fill("50000");
  await page.getByLabel("Size value").press("Enter");
  await expect(page.getByTestId("eq-ticket")).toContainText("Buy 41 RELIANCE");
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await page.getByLabel("Search stocks").fill("REL");
  await page.getByRole("dialog").getByRole("button", { name: /Reliance/i }).first().click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Buy or sell" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Sell/ }).click();
  await expect(page.getByTestId("eq-ticket")).toContainText(/Sell \d+ RELIANCE/);
});

test("@mobile headline flow fits a phone", async ({ page }) => {
  await resetMock();
  await signIn(page);
  await brokerLogin(page);
  await headline(page);
  await expect(page.getByTestId("suggestion")).toContainText("Bull put spread");
  await noHorizontalOverflow(page);
  // every dock tab is fully on screen (no "Optio…" / "S…" cut-offs)
  const vw = page.viewportSize()!.width;
  for (const name of ["Options", "Stocks", "Portfolio", "Orders", "Safety"]) {
    const b = (await page.getByRole("tab", { name }).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vw);
  }
  await review(page);
  const card = (await page.locator(".x-review").boundingBox())!;
  expect(card.width).toBeLessThanOrEqual(vw);
  await noHorizontalOverflow(page);
  await page.getByLabel(/I understand I can lose/).check();
  await page.getByTestId("place").click();
  await expect(page.getByTestId("result")).toContainText("Filled");
  for (const t of ["Portfolio", "Orders", "Safety"] as const) {
    await tab(page, t);
    await page.waitForTimeout(300);
    await noHorizontalOverflow(page);
  }
});
