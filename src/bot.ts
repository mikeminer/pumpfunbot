import BN from "bn.js";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadConfig, DRY_RUN, RPC_URL, Config } from "./config.js";
import { conn, buildBuy, buildSell, simulate, signAndSend, quoteSell, tokenBalance } from "./chain.js";
import { Discovery, CoinStats } from "./discovery.js";
import { preScore, fullScore } from "./scoring.js";
import { loadState, saveState, State, Position } from "./state.js";
import { wallet } from "./wallet.js";
import { log, logTrade } from "./log.js";

let cfg: Config = loadConfig();
const kp = wallet(); const me = kp.publicKey;
const state: State = loadState();
const disc = new Discovery(cfg.candidateMaxAgeSec);
let buying = false;
let managing = false;
const selling = new Set<string>();
const rejectStats: Record<string, number> = {}; let lastSummary = Date.now();
const sol = async () => (await conn.getBalance(me, "confirmed")) / LAMPORTS_PER_SOL;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

let breachCount = 0; // require 3 consecutive breaches to avoid false halts mid-buy
async function heartbeat() {
  try {
    cfg = loadConfig(); // hot-reload risk config
    const bal = await sol();
    if (state.mode === "idle") {
      if (bal >= cfg.activationMinBalanceSol) {
        state.mode = "active"; state.startBalanceSol = bal; state.activatedAt = Date.now();
        log(`ACTIVATED: balance ${bal} SOL >= ${cfg.activationMinBalanceSol}. Start balance recorded. Trading enabled.`);
      }
    }
    let posValue = 0;
    for (const p of state.positions) {
      try {
        const q = await withTimeout(quoteSell(new PublicKey(p.mint), new BN(p.tokens), new PublicKey(p.tokenProgram)), 12_000, `heartbeat quote ${p.symbol}`);
        if (q.lamports.gtn(0)) posValue += Number(q.lamports.toString()) / 1e9; else posValue += p.costSol;
      } catch { posValue += p.costSol; }
    }
    state.lastWalletValueSol = bal + posValue;
    if (state.mode === "active" && state.startBalanceSol) {
      const dd = (1 - state.lastWalletValueSol / state.startBalanceSol) * 100;
      breachCount = dd >= cfg.globalStopDrawdownPct ? breachCount + 1 : 0;
      if (breachCount >= 3) { state.mode = "halted"; state.haltReason = `global stop: wallet value ${state.lastWalletValueSol.toFixed(4)} SOL is ${dd.toFixed(1)}% below start ${state.startBalanceSol}`; log("HALTED (no more buys):", state.haltReason); }
    }
    state.lastHeartbeat = Date.now();
    state.stats = {
      ...disc.counters,
      tracked: disc.coins.size,
      balanceSol: bal,
      lastEventAgeSec: Math.round((Date.now() - disc.lastEventAt) / 1000),
      rpc: RPC_URL.replace(/api-key=[^&]+/, "api-key=***"),
    };
    saveState(state);
  } catch (e: any) { log("heartbeat error:", e.message); }
}

async function tryBuy(c: CoinStats, score: number) {
  const mint = new PublicKey(c.mint);
  const bal = await sol();
  const lamportsBudget = Math.floor(Math.min(cfg.maxSolPerTrade, bal - cfg.feeReserveSol - 0.005) * 1e9);
  if (lamportsBudget < 0.005 * 1e9) { log(`skip buy ${c.symbol}: balance ${bal} too low after ${cfg.feeReserveSol} SOL reserve`); return; }
  const o = await buildBuy(cfg, mint, me, lamportsBudget);
  const totalCost = Number(o.inAmount.toString()) * (1 + cfg.slippagePct / 100) + o.feesLamports + o.ataRentLamports;
  if (bal * 1e9 - totalCost < cfg.feeReserveSol * 1e9) { log(`skip buy ${c.symbol}: would breach fee reserve`); return; }
  if (o.impactPct > cfg.maxPriceImpactPct) { log(`skip buy ${c.symbol}: price impact ${o.impactPct.toFixed(2)}% > ${cfg.maxPriceImpactPct}%`); return; }
  const feePct = (o.feesLamports / lamportsBudget) * 100;
  if (feePct > cfg.maxFeesPctOfTrade) { log(`skip buy ${c.symbol}: fees ${feePct.toFixed(2)}% of trade`); return; }
  const sim = await simulate(o.tx, me, o.userAta);
  const minTokens = o.expectedOut.muln(100 - cfg.slippagePct).divn(100);
  if (!sim.ok || !sim.postTokens || sim.postTokens.lt(minTokens)) { log(`skip buy ${c.symbol}: simulation failed/insufficient out`, JSON.stringify(sim.err), sim.logs.slice(-3)); return; }
  log(`BUY ${c.symbol} ${c.mint} score=${score.toFixed(1)} venue=${o.venue} sol=${lamportsBudget / 1e9} expTokens=${Number(o.expectedOut.toString()) / 1e6} impact=${o.impactPct.toFixed(2)}%`);
  if (DRY_RUN) { logTrade({ mint: c.mint, symbol: c.symbol, side: "BUY", venue: o.venue, sol: lamportsBudget / 1e9, tokens: Number(o.expectedOut.toString()) / 1e6, price: o.execPrice, reason: `dry-run score ${score.toFixed(1)}`, sig: "DRY_RUN", dryRun: true }); return; }
  state.boughtMints.push(c.mint); saveState(state);
  const pre = await conn.getBalance(me, "confirmed");
  const r = await signAndSend(cfg, o.tx, kp);
  if (r.status !== "confirmed") { log(`buy ${c.symbol} not confirmed: ${r.status} sig=${r.sig}`); return; }
  await new Promise((x) => setTimeout(x, 2000));
  const post = await conn.getBalance(me, "confirmed");
  const tokens = await tokenBalance(o.userAta);
  if (tokens.isZero()) { log(`buy ${c.symbol} confirmed but token balance 0? sig=${r.sig}`); return; }
  const spent = (pre - post) / 1e9; const t = Number(tokens.toString()) / 1e6;
  const p: Position = { mint: c.mint, symbol: c.symbol, tokens: tokens.toString(), costSol: spent, entryPrice: spent / t, openedAt: Date.now(), tokenProgram: o.tokenProgram.toBase58(), buySig: r.sig, venue: o.venue };
  state.positions.push(p); saveState(state);
  logTrade({ mint: c.mint, symbol: c.symbol, side: "BUY", venue: o.venue, sol: spent, tokens: t, price: p.entryPrice, reason: `score ${score.toFixed(1)}`, sig: r.sig, dryRun: false });
}

async function sellPosition(p: Position, reason: string) {
  const mint = new PublicKey(p.mint); const ata = getAssociatedTokenAddressSync(mint, me, true, new PublicKey(p.tokenProgram));
  const tokens = await tokenBalance(ata);
  if (tokens.isZero()) { log(`position ${p.symbol} has 0 tokens on-chain, removing`); state.positions = state.positions.filter((x) => x.mint !== p.mint); saveState(state); return; }
  const slips = reason.startsWith("stop") || reason.startsWith("max hold") ? [cfg.slippagePct, 25, 40] : [cfg.slippagePct, 20];
  const deadline = Date.now() + 75_000;
  for (const slip of slips) for (const close of [true, false]) {
    if (Date.now() > deadline) { log(`sell ${p.symbol} deadline reached; will retry`); return; }
    const o = await buildSell(cfg, mint, me, tokens, close, slip);
    const sim = await simulate(o.tx, me, o.userAta);
    if (!sim.ok) { log(`sell sim failed ${p.symbol} slip=${slip} close=${close}:`, JSON.stringify(sim.err), sim.logs.slice(-2)); continue; }
    if (DRY_RUN) { log(`DRY_RUN sell ${p.symbol} (${reason})`); return; }
    const pre = await conn.getBalance(me, "confirmed");
    const r = await signAndSend(cfg, o.tx, kp);
    if (r.status !== "confirmed") { log(`sell ${p.symbol} not confirmed: ${r.status} sig=${r.sig}; trying next attempt`); continue; }
    await new Promise((x) => setTimeout(x, 2000));
    const got = ((await conn.getBalance(me, "confirmed")) - pre) / 1e9;
    const pnl = got - p.costSol; state.realizedPnlSol += pnl;
    state.positions = state.positions.filter((x) => x.mint !== p.mint); saveState(state);
    const t = Number(tokens.toString()) / 1e6;
    logTrade({ mint: p.mint, symbol: p.symbol, side: "SELL", venue: o.venue, sol: got, tokens: t, price: got / t, pnlSol: pnl, pnlPct: (pnl / p.costSol) * 100, reason, sig: r.sig, dryRun: false });
    log(`SOLD ${p.symbol} (${reason}) got=${got.toFixed(5)} SOL pnl=${pnl.toFixed(5)} SOL`);
    return;
  }
  log(`could not sell ${p.symbol} this round; will retry`);
}

const migrateLogAt = new Map<string, number>();
async function managePositions() {
  if (managing) return;
  managing = true;
  try {
    cfg = loadConfig();
    for (const p of [...state.positions]) {
      try {
        const heldMin = (Date.now() - p.openedAt) / 60_000;
        const maxHoldHit = heldMin >= cfg.maxHoldMinutes;
        let q: { venue: string; lamports: InstanceType<typeof BN>; spot: number } | null = null;
        try {
          q = await withTimeout(quoteSell(new PublicKey(p.mint), new BN(p.tokens), new PublicKey(p.tokenProgram)), 12_000, `quoteSell ${p.symbol}`);
        } catch (e: any) {
          log(`manage ${p.symbol} quote error:`, e.message);
          if (!maxHoldHit) continue;
        }
        if (q?.venue === "migrating") {
          const last = migrateLogAt.get(p.mint) ?? 0;
          if (Date.now() - last > 30_000) {
            log(`manage ${p.symbol}: still migrating, held ${heldMin.toFixed(1)}min`);
            migrateLogAt.set(p.mint, Date.now());
          }
          if (!maxHoldHit) continue;
        }
        let reason = "";
        if (q && q.venue !== "migrating" && q.lamports.gten(0)) {
          const value = Number(q.lamports.toString()) / 1e9; const pnlPct = ((value - p.costSol) / p.costSol) * 100;
          p.peakPnlPct = Math.max(p.peakPnlPct ?? -100, pnlPct);
          p.venue = q.venue;
          if (pnlPct >= cfg.takeProfitPct) reason = `take profit ${pnlPct.toFixed(1)}%`;
          else if (pnlPct <= -cfg.stopLossPct) reason = `stop loss ${pnlPct.toFixed(1)}%`;
          else if (maxHoldHit) reason = `max hold ${heldMin.toFixed(0)}min pnl ${pnlPct.toFixed(1)}%`;
        } else if (maxHoldHit) {
          reason = `max hold ${heldMin.toFixed(0)}min (quote unavailable)`;
        }
        if (reason) {
          if (selling.has(p.mint)) continue;
          selling.add(p.mint);
          try { await sellPosition(p, reason); }
          finally { selling.delete(p.mint); }
        }
      } catch (e: any) { log(`manage ${p.symbol} error:`, e.message); }
    }
  } finally { managing = false; }
}

async function evaluate() {
  if (buying || state.mode !== "active" || state.positions.length >= cfg.maxOpenPositions) return;
  const now = Date.now();
  const cands = [...disc.coins.values()].filter((c) => !c.rejected && !state.boughtMints.includes(c.mint) && (cfg.buyGraduated || !c.complete)
    && (now - c.createdAt) / 1000 >= cfg.candidateMinAgeSec && (now - c.createdAt) / 1000 <= cfg.candidateMaxAgeSec && now - c.lastEvalAt > cfg.evaluateEverySec * 1000);
  const pre = cands.map((c) => ({ c, s: preScore(c, cfg) })).filter((x) => { x.c.lastEvalAt = now; if (x.s.reject) { const k = x.s.reject.replace(/[\d.]+%?/g, '#'); rejectStats[k] = (rejectStats[k] ?? 0) + 1; } else if (x.s.score + 15 < cfg.minScore) rejectStats['prescore too low'] = (rejectStats['prescore too low'] ?? 0) + 1; if (x.s.reject?.startsWith("dev") || x.s.reject?.startsWith("snipers") || x.s.reject === "mayhem mode") x.c.rejected = x.s.reject; return !x.s.reject && x.s.score + 15 >= cfg.minScore; })
    .sort((a, b) => b.s.score - a.s.score).slice(0, 3);
  if (Date.now() - lastSummary > Number(process.env.SUMMARY_SEC ?? 600) * 1000) { log('eval summary (since last):', rejectStats, 'best pre-scores:', [...disc.coins.values()].filter(c=>!c.rejected).map(c=>({s:+preScore(c,cfg).score.toFixed(1),sym:c.symbol})).sort((a,b)=>b.s-a.s).slice(0,3)); for (const k in rejectStats) delete rejectStats[k]; lastSummary = Date.now(); }
  buying = true;
  try {
    for (const { c, s } of pre) {
      if (state.positions.length >= cfg.maxOpenPositions || state.mode !== "active") break;
      try {
        const f = await fullScore(c, cfg, s);
        if (f.reject) { c.rejected = f.reject; log(`reject ${c.symbol}: ${f.reject}`); continue; }
        log(`candidate ${c.symbol} ${c.mint} score=${f.score.toFixed(1)}`, f.parts);
        if (f.score >= cfg.minScore) { await tryBuy(c, f.score); break; }
      } catch (e: any) { log(`eval ${c.symbol} error:`, e.message); }
    }
  } finally { buying = false; }
}

function scheduleManage() {
  const ms = Math.max(1, (cfg.positionPollSec || 5) * 1000);
  setTimeout(() => {
    managePositions()
      .catch((e) => log("manage error", e.message))
      .finally(() => scheduleManage());
  }, ms);
}

async function main() {
  log(`pump-bot starting. wallet=${me.toBase58()} dryRun=${DRY_RUN} mode=${state.mode}`);
  disc.start();
  await heartbeat();
  if (state.mode === "idle") log(`IDLE: waiting for balance >= ${cfg.activationMinBalanceSol} SOL on ${me.toBase58()}`);
  setInterval(heartbeat, 15_000);
  scheduleManage();
  setInterval(() => evaluate().catch((e) => log("evaluate error", e.message)), 3000);
}
process.on("unhandledRejection", (e: any) => log("unhandledRejection:", e?.message ?? String(e)));
main();
