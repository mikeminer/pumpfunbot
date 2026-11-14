import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
export const ROOT = new URL("..", import.meta.url).pathname;
export type Config = {
  activationMinBalanceSol: number; maxSolPerTrade: number; maxOpenPositions: number;
  takeProfitPct: number; stopLossPct: number; globalStopDrawdownPct: number; feeReserveSol: number;
  maxHoldMinutes: number; slippagePct: number; maxPriceImpactPct: number; maxFeesPctOfTrade: number;
  priorityFeeMicroLamports: number; computeUnitsCurve: number; computeUnitsAmm: number;
  frontRunProtection: boolean; jitoTipSol: number; jitoFallbackToRpc: boolean;
  minScore: number; candidateMinAgeSec: number; candidateMaxAgeSec: number; minRealSolInCurve: number;
  maxBondingProgressPct: number; minUniqueBuyers: number; maxTop1HolderPct: number; maxTop10HolderPct: number;
  maxDevHoldingPct: number; skipMayhemMode: boolean; buyGraduated: boolean;
  positionPollSec: number; evaluateEverySec: number;
};
export function loadConfig(): Config {
  return JSON.parse(readFileSync(process.env.CONFIG_PATH || join(ROOT, "config.json"), "utf8"));
}
export const RPC_URL = process.env.RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
export const WS_URL = process.env.WS_URL?.trim() || undefined;
export const DRY_RUN = process.env.DRY_RUN === "1";
export const PATHS = {
  wallet: join(ROOT, "secrets/wallet.json"),
  state: process.env.STATE_PATH || join(ROOT, "data/state.json"),
  trades: process.env.TRADES_PATH || join(ROOT, "trades.csv"),
  log: join(ROOT, "data/bot.log"),
};
