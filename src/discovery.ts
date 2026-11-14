import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_SDK, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { createHash } from "crypto";
import { RPC_URL, WS_URL } from "./config.js";
import { isSolQuote } from "./chain.js";
import { log } from "./log.js";

const disc = (n: string) => createHash("sha256").update("event:" + n).digest().subarray(0, 8).toString("hex");
const D = { create: disc("CreateEvent"), trade: disc("TradeEvent"), complete: disc("CompleteEvent") };

export type TradeRec = { t: number; user: string; buy: boolean; sol: number; tokens: number };
export type CoinStats = {
  mint: string; symbol: string; name: string; creator: string; createdAt: number; createSlot: number;
  tokenProgram: string; mayhem: boolean; trades: TradeRec[]; buyers: Set<string>;
  devBoughtTokens: number; devSoldTokens: number; sniperTokens: number; // bought in creation slot by non-dev
  lastRealSol: number; lastVirtSol: number; lastVirtTok: number; complete: boolean; lastEvalAt: number; rejected?: string;
};

export class Discovery {
  coins = new Map<string, CoinStats>();
  lastEventAt = Date.now();
  counters = { creates: 0, trades: 0, completes: 0, reconnects: 0 };
  private conn!: Connection; private subId: number | null = null;
  constructor(private maxAgeSec: number) {}

  start() { this.connect(); setInterval(() => this.watchdog(), 20_000); setInterval(() => this.gc(), 60_000); }

  private connect() {
    this.conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });
    this.subId = this.conn.onLogs(PUMP_PROGRAM_ID, (l, ctx) => { if (!l.err) this.handle(l.logs, ctx.slot); }, "confirmed");
    log("discovery: subscribed to pump program logs");
  }
  private async watchdog() {
    if (Date.now() - this.lastEventAt > 60_000) {
      log("discovery: no events for 60s, reconnecting websocket");
      this.counters.reconnects++;
      try { if (this.subId != null) await this.conn.removeOnLogsListener(this.subId); } catch {}
      this.lastEventAt = Date.now(); this.connect();
    }
  }
  private gc() {
    const cutoff = Date.now() - (this.maxAgeSec + 600) * 1000;
    for (const [k, c] of this.coins) if (c.createdAt < cutoff) this.coins.delete(k);
  }
  private handle(logs: string[], slot: number) {
    this.lastEventAt = Date.now();
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const b = Buffer.from(line.slice(14), "base64"); const d = b.subarray(0, 8).toString("hex");
      try {
        if (d === D.create) {
          const e = PUMP_SDK.decodeCreateEventBc(b.subarray(8)); this.counters.creates++;
          if (!isSolQuote(e.quoteMint)) continue;
          this.coins.set(e.mint.toBase58(), { mint: e.mint.toBase58(), symbol: e.symbol, name: e.name, creator: e.creator.toBase58(), createdAt: Date.now(), createSlot: slot, tokenProgram: e.tokenProgram.toBase58(), mayhem: e.isMayhemMode, trades: [], buyers: new Set(), devBoughtTokens: 0, devSoldTokens: 0, sniperTokens: 0, lastRealSol: 0, lastVirtSol: Number(e.virtualSolReserves.toString()), lastVirtTok: Number(e.virtualTokenReserves.toString()), complete: false, lastEvalAt: 0 });
        } else if (d === D.trade) {
          const e = PUMP_SDK.decodeTradeEventBc(b.subarray(8)); this.counters.trades++;
          const c = this.coins.get(e.mint.toBase58()); if (!c) continue;
          const user = e.user.toBase58(); const tokens = Number(e.tokenAmount.toString()) / 1e6; const sol = Number(e.solAmount.toString()) / 1e9;
          c.trades.push({ t: Date.now(), user, buy: e.isBuy, sol, tokens });
          if (c.trades.length > 2000) c.trades.splice(0, 500);
          if (e.isBuy) c.buyers.add(user);
          if (user === c.creator) { if (e.isBuy) c.devBoughtTokens += tokens; else c.devSoldTokens += tokens; }
          else if (e.isBuy && slot <= c.createSlot + 1) c.sniperTokens += tokens;
          c.lastRealSol = Number(e.realSolReserves.toString()) / 1e9;
          c.lastVirtSol = Number(e.virtualSolReserves.toString()); c.lastVirtTok = Number(e.virtualTokenReserves.toString());
        } else if (d === D.complete) {
          this.counters.completes++;
          const e: any = PUMP_SDK.decodeCompleteEventBc(b.subarray(8));
          const c = this.coins.get(e.mint.toBase58()); if (c) c.complete = true;
        }
      } catch { /* ignore undecodable */ }
    }
  }
}
