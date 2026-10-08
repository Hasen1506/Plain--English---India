// Brokers that can plug into the same interface. NOT IMPLEMENTED: every call
// throws NotImplementedError, and the gateway refuses to start with one of these
// selected. They exist so the shape of the work is clear, not to pretend support.
//
//   Zerodha Kite Connect  https://kite.trade/docs/connect/v3/
//   Dhan HQ               https://dhanhq.co/docs/v2/
//   Fyers API v3          https://myapi.fyers.in/docsv3
//   Angel One SmartAPI    https://smartapi.angelbroking.com/docs

import { NotImplementedError, type BrokerAdapter, type BrokerId, type BrokerInfo } from "./types.ts";

const DOCS: Record<Exclude<BrokerId, "upstox">, [string, string]> = {
  zerodha: ["Zerodha Kite Connect", "https://kite.trade/docs/connect/v3/"],
  dhan: ["Dhan", "https://dhanhq.co/docs/v2/"],
  fyers: ["Fyers", "https://myapi.fyers.in/docsv3"],
  angel: ["Angel One SmartAPI", "https://smartapi.angelbroking.com/docs"],
};

export function stubAdapter(id: Exclude<BrokerId, "upstox">): BrokerAdapter {
  const [name, docs] = DOCS[id];
  const info: BrokerInfo = { id, name, status: "not-implemented", docs, sandbox: false };
  return new Proxy({ info } as BrokerAdapter, {
    get(target, prop) {
      if (prop === "info") return info;
      if (prop === "then") return undefined; // not a thenable
      if (prop === "session") return () => null;
      return () => {
        throw new NotImplementedError(id, String(prop));
      };
    },
  });
}

export const STUB_BROKERS = Object.keys(DOCS) as Exclude<BrokerId, "upstox">[];
