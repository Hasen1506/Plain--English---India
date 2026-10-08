// Demo mode (the public Pages site): the whole UI on the recorded 8 Oct 2026 fixtures,
// clearly labelled, paper only, and it never talks to a gateway or a broker.
import { test, expect } from "@playwright/test";
import { review, tab, noHorizontalOverflow, DEMO_LABEL } from "./helpers.ts";

test("@mobile Try the demo: labelled everywhere, recorded prices, paper trade fills, nothing leaves the browser", async ({ page }) => {
  const outbound: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).port !== "18779") outbound.push(r.url()); // anything but the static site itself
  });
  await page.goto("/");
  await page.getByTestId("try-demo").click();
  await expect(page.getByTestId("demo-bar")).toContainText(DEMO_LABEL.replace("DEMO · ", ""));
  await expect(page.getByTestId("demo-bar")).toContainText("DEMO");
  await expect(page.getByTestId("broker-chip")).toContainText("Demo · no broker");
  await expect(page.getByTestId("market-chip")).toContainText("Recorded session · 8 Oct 2026");
  await expect(page.getByTestId("chain-meta")).toContainText("Recorded");
  await expect(page.getByTestId("chain-meta")).not.toContainText("Live");
  await expect(page.getByRole("group", { name: "Trading mode" }).getByRole("button", { name: "Live" })).toBeDisabled();
  // the headline view is pre-filled: Nifty stays above 22,300 by Tue 13 Oct, risking ₹5,000
  await expect(page.getByTestId("sentence")).toContainText("Nifty 50");
  await expect(page.getByRole("button", { name: "Level" })).toContainText("22,300");
  await expect(page.getByRole("button", { name: "Expiry" })).toContainText("Tue 13 Oct");
  await expect(page.getByTestId("spot")).toHaveText("22,433.75");
  await expect(page.getByTestId("suggestion")).toContainText("SELL NIFTY 22300 PE");
  await noHorizontalOverflow(page);

  // picker: recorded spot only, no day % and no sparkline (the recording has neither)
  await page.getByRole("button", { name: "Underlying" }).click();
  await expect(page.getByRole("dialog")).toContainText("Recorded 8 Oct 2026 snapshot");
  await expect(page.getByRole("dialog").locator(".x-spark")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await review(page);
  await expect(page.getByTestId("review-title")).toContainText("PAPER");
  await expect(page.getByTestId("review-title")).toContainText("DEMO");
  await expect(page.getByRole("heading", { name: /Make ₹1,742 if Nifty 50 stays above 22,300 by Tue 13 Oct/ })).toBeVisible();
  await expect(page.locator("[data-margin]")).toContainText("no broker in the demo");
  await expect(page.getByTestId("broker-charges")).toContainText("no broker in the demo");
  await page.getByLabel(/I understand I can lose/).check();
  await expect(page.getByTestId("place")).toContainText("Place paper trade");
  await page.getByTestId("place").click();
  await expect(page.getByTestId("result")).toContainText("Paper · Filled");
  await page.getByRole("button", { name: "See portfolio" }).click();
  await expect(page.getByRole("heading", { name: "Paper portfolio" })).toBeVisible();
  await expect(page.getByTestId("position")).toHaveCount(2);
  await expect(page.getByText("marked at the recorded 8 Oct 2026 prices")).toBeVisible();
  await tab(page, "Safety");
  await expect(page.getByRole("button", { name: "Log in to Upstox" })).toBeDisabled();
  await page.getByTestId("exit-phrase").fill("EXIT ALL");
  await page.getByTestId("exit-all").click();
  await expect(page.getByTestId("exit-result")).toContainText("closed");
  await noHorizontalOverflow(page);
  expect(outbound).toEqual([]);

  await page.getByRole("button", { name: "Exit demo" }).click();
  await expect(page.getByLabel("Gateway passphrase")).toBeVisible();
});

test("demo deep link (#demo) and stocks in the demo stay honest about missing prices", async ({ page }) => {
  await page.goto("/#demo");
  await expect(page.getByTestId("demo-bar")).toBeVisible();
  await tab(page, "Stocks");
  const t = page.getByTestId("eq-ticket");
  await expect(t).toContainText("RELIANCE");
  await expect(t).toContainText("(recorded)");
  await expect(t).toContainText("No full order book");
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await page.getByLabel("Search stocks").fill("INFY");
  await page.getByRole("dialog").getByRole("button", { name: /INFY/ }).click();
  await expect(page.getByText(/No recorded price for INFY in the demo/)).toBeVisible();
});
