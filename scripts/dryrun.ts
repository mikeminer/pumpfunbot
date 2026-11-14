// End-to-end test without funds: discovery -> scoring -> quote -> tx build -> simulateTransaction.
// Simulations use a real on-chain trader as the (unsigned) fee payer, since our wallet is empty. Nothing is sent.
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-swap-sdk";
import { loadConfig } from "../src/config.js";
import { conn, buildBuy, buildSell, simulate, marketState, tokenBalance } from "../src/chain.js";
import { Discovery } from "../src/discovery.js";
import { preScore, fullScore } from "../src/scoring.js";

const cfg = loadConfig(); const listenSec = Number(process.env.LISTEN_SEC ?? 90);
const d = new Discovery(3600); d.start();
console.log(`listening ${listenSec}s to pump.fun program logs...`);
await new Promise((r) => setTimeout(r, listenSec * 1000));
console.log("counters", d.counters, "tracked", d.coins.size);
const scored = [...d.coins.values()].map((c) => ({ c, s: preScore({ ...c, createdAt: c.createdAt }, { ...cfg, minUniqueBuyers: 3, minRealSolInCurve: 0.5 }) }));
const ok = scored.filter((x) => !x.s.reject).sort((a, b) => b.s.score - a.s.score);
const rejCounts: Record<string, number> = {}; scored.forEach((x) => { if (x.s.reject) { const k = x.s.reject.split(" ")[0] + " " + (x.s.reject.split(" ")[1] ?? ""); rejCounts[k] = (rejCounts[k] ?? 0) + 1; } });
console.log("pre-score rejections (relaxed thresholds for test):", rejCounts);
console.log("top pre-scores:", ok.slice(0, 5).map((x) => ({ sym: x.c.symbol, mint: x.c.mint, score: +x.s.score.toFixed(1), buyers: x.c.buyers.size, realSol: +x.c.lastRealSol.toFixed(2) })));

async function testCurve() {
  const pool = [...ok, ...scored.filter((x) => x.s.reject && !x.c.mayhem).sort((a, b) => b.c.lastRealSol - a.c.lastRealSol)];
  for (const { c, s } of pool.slice(0, 6)) {
    try {
      const f = s.reject ? s : await fullScore(c, cfg, s); console.log(`fullScore ${c.symbol}:`, f.reject ?? f.score.toFixed(1), { top1: f.metrics.top1Pct?.toFixed(2), top10: f.metrics.top10Pct?.toFixed(2) });
      const ms = await marketState(new PublicKey(c.mint)); if (ms.venue !== "curve") continue;
      // proxy payer: a recent buyer who still holds tokens and has SOL
      const buyers = [...new Set(c.trades.filter((t) => t.buy).map((t) => t.user))].reverse();
      for (const u of buyers.slice(0, 8)) {
        const user = new PublicKey(u); const lam = await conn.getBalance(user);
        if (lam < 0.1e9) continue;
        const b = await buildBuy(cfg, new PublicKey(c.mint), user, 0.05e9);
        const sim = await simulate(b.tx, user, b.userAta);
        console.log(`CURVE BUY sim ${c.symbol}: ok=${sim.ok} err=${JSON.stringify(sim.err)} units=${sim.units} expTokens=${Number(b.expectedOut)/1e6} impact=${b.impactPct.toFixed(2)}% feesLamports=${b.feesLamports} ataRent=${b.ataRentLamports}`);
        if (!sim.ok) console.log(sim.logs.slice(-6).join("\n"));
        const held = await tokenBalance(getAssociatedTokenAddressSync(new PublicKey(c.mint), user, true, ms.tokenProgram));
        if (held.gtn(0)) {
          const sl = await buildSell(cfg, new PublicKey(c.mint), user, held, true);
          const ss = await simulate(sl.tx, user, sl.userAta);
          console.log(`CURVE SELL(+close ATA) sim ${c.symbol}: ok=${ss.ok} err=${JSON.stringify(ss.err)} expSol=${Number(sl.expectedOut)/1e9} minSol=${Number(sl.minOut)/1e9}`);
          if (!ss.ok) console.log(ss.logs.slice(-6).join("\n"));
        }
        return true;
      }
    } catch (e: any) { console.log("curve test error", c.symbol, e.message); }
  }
  return false;
}

async function testAmm() {
  const sigs = await conn.getSignaturesForAddress(PUMP_AMM_PROGRAM_ID, { limit: 80 });
  for (const s of sigs) {
    if (s.err) continue;
    let tx: any; try { tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); } catch { continue; }
    const pre = tx?.meta?.postTokenBalances?.find((b) => b.mint.endsWith("pump") && b.owner === tx!.transaction.message.accountKeys[0].pubkey.toBase58());
    if (!pre) continue;
    const mint = new PublicKey(pre.mint); const user = tx!.transaction.message.accountKeys[0].pubkey;
    try {
      const ms = await marketState(mint); if (ms.venue !== "amm") continue;
      if ((await conn.getBalance(user)) < 0.1e9) continue;
      const b = await buildBuy(cfg, mint, user, 0.05e9);
      const sim = await simulate(b.tx, user, b.userAta);
      console.log(`AMM BUY sim ${mint.toBase58()}: ok=${sim.ok} err=${JSON.stringify(sim.err)} units=${sim.units} expTokens=${Number(b.expectedOut)/1e6} impact=${b.impactPct.toFixed(2)}%`);
      if (!sim.ok) console.log(sim.logs.slice(-6).join("\n"));
      const held = new BN(pre.uiTokenAmount.amount);
      if (held.gtn(0)) {
        const sl = await buildSell(cfg, mint, user, held, false);
        const ss = await simulate(sl.tx, user, sl.userAta);
        console.log(`AMM SELL sim: ok=${ss.ok} err=${JSON.stringify(ss.err)} expSol=${Number(sl.expectedOut)/1e9}`);
        if (!ss.ok) console.log(ss.logs.slice(-6).join("\n"));
      }
      return true;
    } catch (e: any) { console.log("amm test error", e.message); }
  }
  return false;
}
console.log("curve test done:", await testCurve());
console.log("amm test done:", await testAmm());
process.exit(0);
