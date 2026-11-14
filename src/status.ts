import BN from "bn.js";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { conn, quoteSell } from "./chain.js";
import { loadState } from "./state.js";
import { loadConfig, PATHS } from "./config.js";
import { wallet } from "./wallet.js";
const me = wallet().publicKey; const s = loadState(); const cfg = loadConfig();
const bal = (await conn.getBalance(me)) / LAMPORTS_PER_SOL;
let proc = "unknown"; try { const j = JSON.parse(execSync("pm2 jlist", { stdio: ["ignore", "pipe", "ignore"] }).toString()); const p = j.find((x: any) => x.name === "pump-bot"); proc = p ? `${p.pm2_env.status} (restarts ${p.pm2_env.restart_time}, pid ${p.pid})` : "not in pm2"; } catch {}
console.log(`Wallet:        ${me.toBase58()}`);
console.log(`Process:       ${proc}`);
console.log(`Mode:          ${s.mode}${s.haltReason ? " — " + s.haltReason : ""}${s.mode === "idle" ? ` (waiting for >= ${cfg.activationMinBalanceSol} SOL)` : ""}`);
console.log(`SOL balance:   ${bal}`);
console.log(`Start balance: ${s.startBalanceSol ?? "-"}   Last heartbeat: ${s.lastHeartbeat ? new Date(s.lastHeartbeat).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) + " (Europe/Rome)" : "-"}`);
console.log(`Discovery:     ${JSON.stringify(s.stats ?? {})}`);
let posVal = 0; let unreal = 0;
console.log(`Open positions (${s.positions.length}/${cfg.maxOpenPositions}):`);
for (const p of s.positions) {
  try { const q = await quoteSell(new PublicKey(p.mint), new BN(p.tokens), new PublicKey(p.tokenProgram)); const v = Number(q.lamports.toString()) / 1e9; posVal += Math.max(v, 0); unreal += v - p.costSol;
    console.log(`  ${p.symbol.padEnd(12)} ${p.mint} venue=${q.venue} cost=${p.costSol.toFixed(4)} value=${v.toFixed(4)} pnl=${(((v - p.costSol) / p.costSol) * 100).toFixed(1)}% held=${((Date.now() - p.openedAt) / 60000).toFixed(0)}min`);
  } catch (e: any) { console.log(`  ${p.symbol} ${p.mint} (quote error: ${e.message})`); }
}
let trades = 0; if (existsSync(PATHS.trades)) trades = readFileSync(PATHS.trades, "utf8").trim().split("\n").length - 1;
console.log(`Realized PnL:  ${s.realizedPnlSol.toFixed(6)} SOL   Unrealized: ${unreal.toFixed(6)} SOL   Trades logged: ${trades}`);
const total = bal + posVal; console.log(`Wallet value:  ${total.toFixed(6)} SOL${s.startBalanceSol ? `   Total PnL vs start: ${(total - s.startBalanceSol).toFixed(6)} SOL (${(((total - s.startBalanceSol) / s.startBalanceSol) * 100).toFixed(1)}%)` : ""}`);
process.exit(0);
