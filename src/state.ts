import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import { PATHS } from "./config.js";
export type Position = { mint: string; symbol: string; tokens: string; costSol: number; entryPrice: number; openedAt: number; tokenProgram: string; buySig: string; venue: string; peakPnlPct?: number };
export type State = { mode: "idle" | "active" | "halted"; startBalanceSol: number | null; activatedAt: number | null; haltReason?: string; positions: Position[]; realizedPnlSol: number; boughtMints: string[]; lastHeartbeat?: number; lastWalletValueSol?: number; stats?: any };
export function loadState(): State {
  if (!existsSync(PATHS.state)) return { mode: "idle", startBalanceSol: null, activatedAt: null, positions: [], realizedPnlSol: 0, boughtMints: [] };
  return JSON.parse(readFileSync(PATHS.state, "utf8"));
}
export function saveState(s: State) {
  mkdirSync(dirname(PATHS.state), { recursive: true });
  writeFileSync(PATHS.state + ".tmp", JSON.stringify(s, null, 2)); renameSync(PATHS.state + ".tmp", PATHS.state);
}
