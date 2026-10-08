// Start the real gateway for E2E with a clean data dir and the test environment.
import { rmSync } from "node:fs";
import { GATEWAY_ENV } from "./env.ts";

rmSync(GATEWAY_ENV.DATA_DIR!, { recursive: true, force: true });
Object.assign(process.env, GATEWAY_ENV);
await import("../../gateway/main.ts");
