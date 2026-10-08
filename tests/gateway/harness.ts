// Spin up the mock Upstox API and a real gateway pointed at it, in-process.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUpstoxMock, MOCK, type Scenario } from "../mock/upstox-mock.ts";
import { createGateway, type Gateway } from "../../gateway/app.ts";
import { loadConfig } from "../../gateway/config.ts";
import { hashPassphrase } from "../../gateway/auth.ts";
import { UpstoxAdapter } from "../../gateway/brokers/upstox/adapter.ts";
import { FIXTURE_NOW } from "../mock/fixtures.ts";

export const PASS = "correct horse battery staple";
export const ORIGIN = "https://owner.github.io";
const HASH = hashPassphrase(PASS, Buffer.alloc(16, 7), 1024); // low cost: tests only

export interface Harness {
  url: string;
  mockUrl: string;
  gw: Gateway;
  dataDir: string;
  token: string;
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Record<string, unknown> & { [k: string]: unknown }; headers: Headers }>;
  scenario: (s: Scenario) => Promise<void>;
  mockState: () => Promise<{ orders: Record<string, unknown>[]; requests: { method: string; path: string; ts: number }[] }>;
  brokerLogin: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const mock = startUpstoxMock(0);
  const mockUrl = await mock.ready;
  const dataDir = mkdtempSync(join(tmpdir(), "pei-gw-"));
  let server: Server;
  const portReady = new Promise<number>((resolve) => {
    server = createServer((req, res) => void gw.handle(req, res));
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const port = await portReady;
  const url = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    NODE_ENV: "test",
    UPSTOX_API_KEY: MOCK.apiKey,
    UPSTOX_API_SECRET: MOCK.apiSecret,
    UPSTOX_REDIRECT_URI: `${url}/auth/broker/callback`,
    UPSTOX_BASE_URL: mockUrl,
    UPSTOX_HFT_URL: mockUrl,
    UPSTOX_ASSETS_URL: mockUrl,
    UPSTOX_LOGIN_URL: mockUrl,
    GATEWAY_PASSPHRASE_HASH: HASH,
    GATEWAY_JWT_SECRET: "test-secret-test-secret-test-secret-0123456789",
    CORS_ORIGINS: ORIGIN,
    FRONTEND_URL: `${ORIGIN}/app/`,
    DATA_DIR: dataDir,
    GATEWAY_FAKE_NOW: String(FIXTURE_NOW),
    ...env,
  });
  const start = Date.now();
  const now = () => FIXTURE_NOW + (Date.now() - start);
  const adapter = new UpstoxAdapter({ apiKey: MOCK.apiKey, apiSecret: MOCK.apiSecret, redirectUri: `${url}/auth/broker/callback`, baseUrl: mockUrl, hftUrl: mockUrl, assetsUrl: mockUrl, loginUrl: mockUrl, now });
  const gw = createGateway({ config, adapter, now, log: () => {}, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
  await gw.init();
  const api: Harness["api"] = async (method, path, body, headers = {}) => {
    const r = await fetch(url + path, { method, headers: { Origin: ORIGIN, ...(h.token ? { Authorization: `Bearer ${h.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : {}, headers: r.headers };
  };
  const h: Harness = {
    url,
    mockUrl,
    gw,
    dataDir,
    token: "",
    api,
    scenario: async (s) => void (await fetch(`${mockUrl}/__mock/scenario`, { method: "POST", body: JSON.stringify(s) })),
    mockState: async () => (await (await fetch(`${mockUrl}/__mock/state`)).json()) as never,
    brokerLogin: async () => {
      const r = await api("GET", "/auth/broker/login");
      // follow the (mock) Upstox dialog → callback on the gateway
      const dialog = await fetch(String(r.body.url), { redirect: "manual" });
      const cb = await fetch(dialog.headers.get("location")!, { redirect: "manual" });
      if (!String(cb.headers.get("location")).includes("broker=connected")) throw new Error(`broker login failed: ${cb.headers.get("location")}`);
    },
    close: async () => {
      gw.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await mock.close();
    },
  };
  const login = await api("POST", "/auth/login", { passphrase: PASS });
  h.token = String(login.body.token);
  return h;
}
