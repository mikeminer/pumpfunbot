import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_SDK, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { createHash } from "crypto";
import { RPC_URL, WS_URL } from "./config.js";
import { isSolQuote } from "./chain.js";
import { log } from "./log.js";

const disc = (n: string) => createHash("sha256").update("event:" + n).digest().subarray(0, 8).toString("hex");
const D = { create: disc("CreateEvent"), trade: disc("TradeEvent"), complete: disc("CompleteEvent") };

const STALE_MS = 25_000;
const WATCHDOG_MS = 5_000;
const UNSUB_TIMEOUT_MS = 1_500;
const PING_MS = 15_000;
const BACKOFF_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000];

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

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
  private conn: Connection | null = null;
  private subId: number | null = null;
  private gen = 0;
  private connectedAt = 0;
  private reconnecting = false;
  private backoffIdx = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  constructor(private maxAgeSec: number) {}

  start() { this.connect(); setInterval(() => this.watchdog(), WATCHDOG_MS); setInterval(() => this.gc(), 60_000); }

  private rpcWs(): any { return (this.conn as any)?._rpcWebSocket ?? null; }

  private rawSocket(): any {
    const ws = this.rpcWs();
    return ws?.socket ?? ws?._socket ?? null;
  }

  private connect() {
    const gen = ++this.gen;
    this.conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });
    this.connectedAt = Date.now();
    this.lastPongAt = Date.now();
    this.subId = this.conn.onLogs(PUMP_PROGRAM_ID, (l, ctx) => {
      if (gen !== this.gen) return;
      // Any log (including failed txs) means the subscription is alive.
      this.lastEventAt = Date.now();
      this.backoffIdx = 0;
      if (!l.err) this.handle(l.logs, ctx.slot);
    }, "confirmed");
    this.attachSocket(gen);
    log(`discovery: subscribed to pump program logs (gen=${gen}, reconnects=${this.counters.reconnects})`);
  }

  private attachSocket(gen: number) {
    const rpcWs = this.rpcWs();
    if (!rpcWs) return;
    const onOpen = () => {
      if (gen !== this.gen) return;
      this.lastPongAt = Date.now();
      this.startPings(gen);
    };
    const onClose = (code: number) => {
      if (gen !== this.gen) return;
      log(`discovery: websocket closed (code=${code})`);
      this.scheduleReconnect(`socket closed (${code})`);
    };
    const onError = (err: any) => {
      if (gen !== this.gen) return;
      log(`discovery: websocket error: ${err?.message ?? String(err)}`);
    };
    try { rpcWs.on("open", onOpen); } catch {}
    try { rpcWs.on("close", onClose); } catch {}
    try { rpcWs.on("error", onError); } catch {}
    // Socket may already be open, or appear shortly after subscribe.
    const hookRaw = (tries = 0) => {
      if (gen !== this.gen) return;
      const sock = this.rawSocket();
      if (!sock) { if (tries < 25) setTimeout(() => hookRaw(tries + 1), 100); return; }
      try {
        sock.on("pong", () => { if (gen === this.gen) this.lastPongAt = Date.now(); });
        sock.on("close", (code: number) => {
          if (gen !== this.gen) return;
          log(`discovery: raw websocket closed (code=${code})`);
          this.scheduleReconnect(`raw socket closed (${code})`);
        });
      } catch {}
      if (sock.readyState === 1) onOpen();
    };
    hookRaw();
  }

  private startPings(gen: number) {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.pingTimer = setInterval(() => {
      if (gen !== this.gen) { if (this.pingTimer) clearInterval(this.pingTimer); return; }
      const sock = this.rawSocket();
      try {
        if (sock && sock.readyState === 1 && typeof sock.ping === "function") sock.ping();
      } catch {}
    }, PING_MS);
  }

  private async teardown() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    const conn = this.conn;
    const subId = this.subId;
    this.subId = null;
    const rpcWs = (conn as any)?._rpcWebSocket;
    try { rpcWs?.setAutoReconnect?.(false); } catch {}
    try {
      if (conn && subId != null) await withTimeout(conn.removeOnLogsListener(subId), UNSUB_TIMEOUT_MS, "unsubscribe");
    } catch {}
    try { if (rpcWs && typeof rpcWs.close === "function") rpcWs.close(); } catch {}
    try { this.rawSocket()?.terminate?.(); } catch {}
    this.conn = null;
  }

  private scheduleReconnect(reason: string) {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.counters.reconnects++;
    // Invalidate in-flight callbacks immediately so old sockets cannot race.
    this.gen++;
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx = Math.min(this.backoffIdx + 1, BACKOFF_MS.length - 1);
    log(`discovery: ${reason}; reconnect #${this.counters.reconnects} in ${delay}ms`);
    setTimeout(() => {
      this.teardown().catch(() => {}).finally(() => {
        try { this.connect(); } catch (e: any) { log("discovery: connect error:", e?.message ?? e); }
        this.reconnecting = false;
      });
    }, delay);
  }

  private watchdog() {
    if (this.reconnecting) return;
    const now = Date.now();
    if (now - this.connectedAt < STALE_MS) return; // grace period after connect/subscribe
    const silent = now - this.lastEventAt;
    if (silent > STALE_MS) {
      this.scheduleReconnect(`no events for ${Math.round(silent / 1000)}s, reconnecting websocket`);
      return;
    }
    // Protocol pongs should arrive if the raw socket is up; if we have been
    // pinging but saw no pong for 2+ intervals while events also look stale-ish, reconnect.
    if (this.lastPongAt && now - this.lastPongAt > PING_MS * 3 && silent > STALE_MS / 2) {
      this.scheduleReconnect(`no websocket pong for ${Math.round((now - this.lastPongAt) / 1000)}s, reconnecting`);
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
