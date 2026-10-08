import { defineConfig, devices } from "@playwright/test";

import { PORTS, URLS } from "./tests/e2e/env.ts";

// Three local processes, all offline: the mock Upstox API (recorded public fixtures),
// the REAL gateway pointed at it (tests/e2e/env.ts), and the built frontend.
const { mock, web } = URLS;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one stateful gateway
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: web,
    trace: "retain-on-failure",
    launchOptions: {
      // sandboxes without Playwright's own browser can point at a system Chromium; CI uses Playwright's
      executablePath: process.env.PW_CHROMIUM || undefined,
      args: ["--no-proxy-server"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: process.env.PW_EXTERNAL_SERVERS
    ? undefined
    : [
        { command: `node --experimental-strip-types --no-warnings tests/mock/upstox-mock.ts ${PORTS.mock}`, url: `${mock}/v2/market/holidays`, reuseExistingServer: !process.env.CI, timeout: 60_000 },
        { command: "node --experimental-strip-types --no-warnings tests/e2e/start-gateway.ts", url: `${URLS.gw}/health`, reuseExistingServer: !process.env.CI, timeout: 90_000 },
        {
          command: `npx vite build --mode e2e --logLevel warn && npx vite preview --mode e2e --outDir ../dist-e2e --port ${PORTS.web} --strictPort --host 127.0.0.1`,
          url: web,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
