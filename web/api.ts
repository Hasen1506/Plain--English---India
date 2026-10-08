// Client for the user's own gateway. The gateway URL and the gateway session token
// live in the browser; broker secrets never do.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LS_URL = "pei.gatewayUrl";
const SS_TOKEN = "pei.token";

export const defaultGateway = (): string => localStorage.getItem(LS_URL) ?? (import.meta.env.VITE_E2E ? "http://127.0.0.1:18780" : (import.meta.env.VITE_GATEWAY_URL ?? ""));

type DemoHandler = (method: string, path: string, body?: Record<string, unknown>) => Promise<unknown>;

export const api = {
  base: defaultGateway(),
  token: sessionStorage.getItem(SS_TOKEN) ?? "",
  /** Demo mode: requests are answered in the browser from recorded fixtures (see demo.ts). */
  demo: null as DemoHandler | null,
  setBase(u: string) {
    this.base = u.trim().replace(/\/$/, "");
    localStorage.setItem(LS_URL, this.base);
  },
  setToken(t: string) {
    this.token = t;
    if (t) sessionStorage.setItem(SS_TOKEN, t);
    else sessionStorage.removeItem(SS_TOKEN);
  },
  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.demo) {
      try {
        return (await this.demo(method, path, (body ?? {}) as Record<string, unknown>)) as T;
      } catch (e) {
        const x = e as { status?: number; code?: string; message: string };
        throw new ApiError(x.status ?? 500, x.code ?? "demo", x.message);
      }
    }
    if (!this.base) throw new ApiError(0, "no-gateway", "Set your gateway URL first");
    let r: Response;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "unreachable", `Gateway unreachable at ${this.base}`);
    }
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!r.ok) {
      if (r.status === 401 && j.error === "unauthorized") this.setToken("");
      throw new ApiError(r.status, String(j.error ?? r.status), String(j.message ?? `HTTP ${r.status}`));
    }
    return j as T;
  },
  get<T = Record<string, unknown>>(p: string) {
    return this.call<T>("GET", p);
  },
  post<T = Record<string, unknown>>(p: string, b: unknown = {}) {
    return this.call<T>("POST", p, b);
  },
  put<T = Record<string, unknown>>(p: string, b: unknown) {
    return this.call<T>("PUT", p, b);
  },
  del<T = Record<string, unknown>>(p: string) {
    return this.call<T>("DELETE", p);
  },
};
