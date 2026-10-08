// Environment for the E2E gateway (mock broker on localhost, fake clock at the fixture time).
export const PORTS = { web: 18779, gateway: 18780, mock: 18781 };
const mock = `http://127.0.0.1:${PORTS.mock}`;
const gw = `http://127.0.0.1:${PORTS.gateway}`;
const web = `http://127.0.0.1:${PORTS.web}`;

export const GATEWAY_ENV: Record<string, string> = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: String(PORTS.gateway),
  DATA_DIR: ".e2e-gw-data",
  UPSTOX_API_KEY: "mock-api-key",
  UPSTOX_API_SECRET: "mock-api-secret",
  UPSTOX_REDIRECT_URI: `${gw}/auth/broker/callback`,
  UPSTOX_BASE_URL: mock,
  UPSTOX_HFT_URL: mock,
  UPSTOX_ASSETS_URL: mock,
  UPSTOX_LOGIN_URL: mock,
  // hash of "e2e passphrase 123" (low scrypt cost: tests only)
  GATEWAY_PASSPHRASE_HASH: "scrypt$1024$8$1$CQkJCQkJCQkJCQkJCQkJCQ==$nhPoyW0A4LzYN68HBqn7fGkd83nY666T4BBnebI4gwE=",
  GATEWAY_JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789",
  CORS_ORIGINS: web,
  FRONTEND_URL: `${web}/`,
  LIVE_TRADING_ENABLED: "1",
  GATEWAY_FAKE_NOW: "1791436140000", // Thu 8 Oct 2026 10:39 IST, when the chain fixtures were recorded
};
export const URLS = { mock, gw, web };
