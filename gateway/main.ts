// Entry point: node --experimental-strip-types gateway/main.ts  (or the Docker image)
import { createServer } from "node:http";
import { loadConfig, ConfigError } from "./config.ts";
import { createGateway, makeClock } from "./app.ts";
import { UpstoxAdapter } from "./brokers/upstox/adapter.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[gateway] configuration error: ${e.message}\nSee docs/SETUP.md and .env.example.`);
    process.exit(2);
  }
  throw e;
}

const now = makeClock(config);
const adapter = new UpstoxAdapter({
  now,
  apiKey: config.upstox.apiKey,
  apiSecret: config.upstox.apiSecret,
  redirectUri: config.upstox.redirectUri,
  baseUrl: config.upstox.baseUrl,
  hftUrl: config.upstox.hftUrl,
  assetsUrl: config.upstox.assetsUrl,
  loginUrl: config.upstox.loginUrl,
  sandbox: config.upstox.sandboxToken ? { token: config.upstox.sandboxToken, url: config.upstox.sandboxUrl } : null,
  algoName: config.upstox.algoName,
});
const gw = createGateway({ config, adapter, now });
await gw.init();
const server = createServer((req, res) => void gw.handle(req, res));
server.listen(config.port, config.host, () => {
  console.log(`[gateway] listening on http://${config.host}:${config.port} · broker ${adapter.info.name}${adapter.info.sandbox ? " (SANDBOX)" : ""} · live trading ${config.liveTrading ? "ENABLED" : "disabled (paper only)"}`);
});
const shutdown = () => {
  gw.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
