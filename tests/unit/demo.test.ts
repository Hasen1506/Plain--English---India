// The demo stand-in for the gateway: recorded data only, paper only.
import { describe, it, expect, beforeAll } from "vitest";
import { createDemo, type Demo } from "../../web/demo.ts";
import { suggest } from "../../src/core/strategy.ts";
import type { Chain } from "../../src/core/chain.ts";

describe("demo mode", () => {
  let d: Demo;
  beforeAll(async () => (d = await createDemo()));

  it("serves the recorded chain and never claims a broker or live trading", async () => {
    const s = (await d.handle("GET", "/api/session")) as { demo: boolean; liveTrading: boolean; broker: { loggedIn: boolean } };
    expect(s).toMatchObject({ demo: true, liveTrading: false, broker: { loggedIn: false } });
    const c = (await d.handle("GET", "/api/chain?u=NIFTY&expiry=2026-10-13")) as Chain;
    expect(c.spot).toBe(22433.75);
    expect(c.source).toMatch(/Recorded/);
    await expect(d.handle("GET", "/api/chain?u=SENSEX&expiry=2026-10-15")).rejects.toMatchObject({ status: 404 });
  });

  it("has no day change or sparkline to show (one snapshot)", async () => {
    const r = (await d.handle("GET", "/api/spots?u=NIFTY,SENSEX")) as { spots: Record<string, { ltp: number | null; changePct: unknown; spark: unknown }> };
    expect(r.spots.NIFTY).toEqual({ ltp: 22433.75, changePct: null, spark: null });
    expect(r.spots.SENSEX!.ltp).toBeNull();
  });

  it("refuses live orders and fills paper spreads on the recorded book", async () => {
    const c = (await d.handle("GET", "/api/chain?u=NIFTY&expiry=2026-10-13")) as Chain;
    const sg = suggest({ underlying: "NIFTY", dir: "above", mode: "stays", level: 22300, expiryDate: "2026-10-13", risk: 5000 }, c, { now: d.now() }).suggestions[0]!;
    const legs = sg.legs.map((l) => ({ key: l.inst.key, side: l.side, qty: l.qty, limit: l.limit }));
    await expect(d.handle("POST", "/api/trade/options", { mode: "live", legs, confirm: "REAL MONEY" })).rejects.toMatchObject({ status: 403 });
    const r = (await d.handle("POST", "/api/trade/options", { mode: "paper", legs })) as { paper: boolean; result: { status: string } };
    expect(r.paper).toBe(true);
    expect(r.result.status).toBe("filled");
    await expect(d.handle("POST", "/api/margin", { legs: [] })).rejects.toMatchObject({ status: 503 });
    await expect(d.handle("GET", "/auth/broker/login")).rejects.toMatchObject({ status: 403 });
  });
});
