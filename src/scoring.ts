import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { Connection } from "@solana/web3.js";
import { conn } from "./chain.js";
import { Config, RPC_URL } from "./config.js";
const noRetry = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true });
import type { CoinStats } from "./discovery.js";

const SUPPLY = 1_000_000_000; // pump tokens: 1B, 6 decimals
export type Score = { score: number; reject?: string; parts: Record<string, number>; metrics: Record<string, number> };

/** Cheap score from the event stream only (no RPC). */
export function preScore(c: CoinStats, cfg: Config): Score {
  const now = Date.now(); const age = (now - c.createdAt) / 1000;
  const parts: Record<string, number> = {}; const m: Record<string, number> = {};
  const recent = c.trades.filter((t) => now - t.t < 60_000);
  const buySol = c.trades.filter((t) => t.buy).reduce((s, t) => s + t.sol, 0);
  const sellSol = c.trades.filter((t) => !t.buy).reduce((s, t) => s + t.sol, 0);
  const recentBuyers = new Set(recent.filter((t) => t.buy).map((t) => t.user)).size;
  const recentNet = recent.reduce((s, t) => s + (t.buy ? t.sol : -t.sol), 0);
  const progress = Math.max(0, (c.lastRealSol / 85) * 100); // ~85 SOL to graduate (approx; exact progress re-read on-chain)
  const devNet = c.devBoughtTokens - c.devSoldTokens;
  Object.assign(m, { age, trades: c.trades.length, uniqueBuyers: c.buyers.size, recentBuyers, buySol, sellSol, recentNet, realSol: c.lastRealSol, progressApprox: progress, devPct: (devNet / SUPPLY) * 100, sniperPct: (c.sniperTokens / SUPPLY) * 100 });
  const rej = (r: string): Score => ({ score: 0, reject: r, parts, metrics: m });
  if (c.mayhem && cfg.skipMayhemMode) return rej("mayhem mode");
  if (c.devSoldTokens > 0) return rej("dev sold");
  if (m.devPct > cfg.maxDevHoldingPct) return rej(`dev holds ${m.devPct.toFixed(1)}%`);
  if (m.sniperPct > 20) return rej(`snipers/bundle ${m.sniperPct.toFixed(1)}% in create slot`);
  if (c.lastRealSol < cfg.minRealSolInCurve) return rej("low liquidity");
  if (c.buyers.size < cfg.minUniqueBuyers) return rej("few buyers");
  parts.momentum = Math.min(25, recentBuyers * 2.5);
  parts.buyPressure = buySol + sellSol > 0 ? Math.max(0, Math.min(15, ((buySol / (buySol + sellSol)) - 0.5) * 60)) : 0;
  parts.netInflow = Math.max(0, Math.min(15, recentNet * 5));
  parts.progress = progress >= 10 && progress <= 60 ? 15 : progress < 10 ? progress * 1.2 : Math.max(0, 15 - (progress - 60) * 0.6);
  parts.dev = Math.max(0, 15 - Math.max(0, m.devPct) * 1.5);
  const score = Object.values(parts).reduce((a, b) => a + b, 0); // max 85 before holder check
  return { score, parts, metrics: m };
}

/** Full score: adds on-chain holder concentration + authority checks (RPC). */
export async function fullScore(c: CoinStats, cfg: Config, pre: Score): Promise<Score> {
  const mint = new PublicKey(c.mint); const s: Score = { ...pre, parts: { ...pre.parts }, metrics: { ...pre.metrics } };
  const tp = new PublicKey(c.tokenProgram);
  const mi = await getMint(conn, mint, "confirmed", tp);
  if (mi.mintAuthority) return { ...s, score: 0, reject: "mint authority not revoked" };
  if (mi.freezeAuthority) return { ...s, score: 0, reject: "freeze authority set" };
  let holders: number[] = []; let src = "chain";
  try {
    const largest = await noRetry.getTokenLargestAccounts(mint, "confirmed");
    const curveOwner = bondingCurvePda(mint).toBase58(); const pool = canonicalPumpPoolPda(mint).toBase58();
    const accs = largest.value.slice(0, 12);
    const infos = await conn.getMultipleParsedAccounts(accs.map((a) => a.address));
    accs.forEach((a, i) => { const owner = (infos.value[i]?.data as any)?.parsed?.info?.owner; if (owner === curveOwner || owner === pool) return; holders.push(Number(a.uiAmount ?? 0)); });
  } catch {
    // Public RPCs often rate-limit/deny getTokenLargestAccounts: derive holder balances from the
    // trade-event stream we have observed since the coin's creation.
    src = "events"; const bal = new Map<string, number>();
    for (const t of c.trades) bal.set(t.user, (bal.get(t.user) ?? 0) + (t.buy ? t.tokens : -t.tokens));
    holders = [...bal.values()].filter((x) => x > 0).sort((a, b) => b - a);
  }
  s.metrics.holderSourceChain = src === "chain" ? 1 : 0;
  const top1 = ((holders[0] ?? 0) / SUPPLY) * 100; const top10 = (holders.slice(0, 10).reduce((a, b) => a + b, 0) / SUPPLY) * 100;
  s.metrics.top1Pct = top1; s.metrics.top10Pct = top10;
  if (top1 > cfg.maxTop1HolderPct) return { ...s, score: 0, reject: `top holder ${top1.toFixed(1)}%` };
  if (top10 > cfg.maxTop10HolderPct) return { ...s, score: 0, reject: `top10 ${top10.toFixed(1)}%` };
  s.parts.holders = Math.max(0, 15 * (1 - top10 / cfg.maxTop10HolderPct));
  s.score = Object.values(s.parts).reduce((a, b) => a + b, 0);
  return s;
}
