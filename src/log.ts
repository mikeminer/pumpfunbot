import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { PATHS } from "./config.js";
export function log(...a: unknown[]) {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  console.log(line);
}
const HEADER = "time,mint,symbol,side,venue,sol,tokens,price_sol_per_token,pnl_sol,pnl_pct,reason,tx_signature,dry_run\n";
export function logTrade(t: { mint: string; symbol: string; side: "BUY" | "SELL"; venue: string; sol: number; tokens: number; price: number; pnlSol?: number; pnlPct?: number; reason?: string; sig: string; dryRun: boolean }) {
  mkdirSync(dirname(PATHS.trades), { recursive: true });
  if (!existsSync(PATHS.trades)) writeFileSync(PATHS.trades, HEADER);
  const esc = (s: string) => `"${s.replace(/"/g, "'")}"`;
  appendFileSync(PATHS.trades, [new Date().toISOString(), t.mint, esc(t.symbol), t.side, t.venue, t.sol.toFixed(9), t.tokens.toFixed(6), t.price.toExponential(6), t.pnlSol?.toFixed(9) ?? "", t.pnlPct?.toFixed(2) ?? "", esc(t.reason ?? ""), t.sig, t.dryRun ? 1 : 0].join(",") + "\n");
}
