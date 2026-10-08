import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  { root: ".", test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup.ts"] } },
  { root: ".", test: { name: "diff", include: ["tests/diff/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup.ts"] } },
  { root: ".", test: { name: "gateway", include: ["tests/gateway/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup.ts"], testTimeout: 20_000 } },
  // opt-in: needs UPSTOX_SANDBOX_TOKEN (sandbox orders only) and/or UPSTOX_ACCESS_TOKEN (read-only live data)
  { root: ".", test: { name: "live", include: ["tests/live/**/*.test.ts"], environment: "node", testTimeout: 60_000 } },
]);
