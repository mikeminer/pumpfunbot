import BN from "bn.js";
import {
  Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL, Keypair,
} from "@solana/web3.js";
import {
  PUMP_SDK, OnlinePumpSdk, bondingCurvePda, getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount, getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import {
  OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda, buyQuoteInput, sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import {
  getAssociatedTokenAddressSync, createCloseAccountInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import { RPC_URL, WS_URL, Config } from "./config.js";

export const conn = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL });
const onlineSdk = new OnlinePumpSdk(conn);
const onlineAmm = new OnlinePumpAmmSdk(conn);
const SOL_QUOTES = new Set(["11111111111111111111111111111111", NATIVE_MINT.toBase58()]);
export const isSolQuote = (q?: PublicKey) => !q || SOL_QUOTES.has(q.toBase58());

// Jito (from pump-fun-skills swap/scripts/lib/jito.mjs)
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((k) => new PublicKey(k));
const JITO_ENDPOINTS = ["mainnet", "amsterdam.mainnet", "frankfurt.mainnet", "london.mainnet", "ny.mainnet", "slc.mainnet", "singapore.mainnet", "tokyo.mainnet"]
  .map((h) => `https://${h}.block-engine.jito.wtf/api/v1/transactions`);

let globalCache: { g: any; f: any; t: number } | null = null;
async function globals() {
  if (!globalCache || Date.now() - globalCache.t > 10 * 60_000) {
    const [g, f] = await Promise.all([onlineSdk.fetchGlobal(), onlineSdk.fetchFeeConfig()]);
    globalCache = { g, f, t: Date.now() };
  }
  return globalCache;
}

export async function tokenProgramOf(mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, "confirmed"); // never trust API token_program
  if (!info) throw new Error("mint not found");
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("mint not SPL token");
  return info.owner;
}

export type MarketState =
  | { venue: "curve"; bcInfo: any; bc: any; tokenProgram: PublicKey; spot: number; realSol: number; progressPct: number }
  | { venue: "amm"; poolKey: PublicKey; tokenProgram: PublicKey; spot: number; realSol: number; progressPct: 100 }
  | { venue: "migrating"; tokenProgram: PublicKey };

/** spot price in SOL per whole token (6 decimals) */
export async function marketState(mint: PublicKey, tokenProgram?: PublicKey): Promise<MarketState> {
  const tp = tokenProgram ?? (await tokenProgramOf(mint));
  const bcInfo = await conn.getAccountInfo(bondingCurvePda(mint), "confirmed");
  if (!bcInfo) throw new Error("bonding curve not found");
  const bc = PUMP_SDK.decodeBondingCurve(bcInfo);
  if (!isSolQuote(bc.quoteMint)) throw new Error("non-SOL quoted curve (unsupported)");
  if (!bc.complete) {
    const { g } = await globals();
    const init = Number(g.initialRealTokenReserves.toString());
    const progressPct = init > 0 ? (1 - Number(bc.realTokenReserves.toString()) / init) * 100 : 0;
    const spot = Number(bc.virtualQuoteReserves.toString()) / 1e9 / (Number(bc.virtualTokenReserves.toString()) / 1e6);
    return { venue: "curve", bcInfo, bc, tokenProgram: tp, spot, realSol: Number(bc.realQuoteReserves.toString()) / 1e9, progressPct };
  }
  const poolKey = canonicalPumpPoolPda(mint);
  const poolInfo = await conn.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) return { venue: "migrating", tokenProgram: tp };
  const st = await onlineAmm.swapSolanaState(poolKey, Keypair.generate().publicKey);
  const q = Number(st.poolQuoteAmount.toString()) + Number((st.pool.virtualQuoteReserves ?? new BN(0)).toString());
  const spot = q / 1e9 / (Number(st.poolBaseAmount.toString()) / 1e6);
  return { venue: "amm", poolKey, tokenProgram: tp, spot, realSol: Number(st.poolQuoteAmount.toString()) / 1e9, progressPct: 100 };
}

export type BuiltOrder = {
  tx: VersionedTransaction; venue: "curve" | "amm"; side: "buy" | "sell";
  expectedOut: BN;   // tokens (buy) or lamports (sell)
  minOut: BN;        // after slippage
  inAmount: BN;      // lamports (buy) or tokens (sell)
  spot: number; execPrice: number; impactPct: number;
  feesLamports: number; ataRentLamports: number; userAta: PublicKey; tokenProgram: PublicKey;
};

function budgetIxs(cfg: Config, units: number) {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityFeeMicroLamports })];
}
async function assemble(cfg: Config, payer: PublicKey, ixs: TransactionInstruction[], units: number) {
  const all = [...budgetIxs(cfg, units)];
  if (cfg.frontRunProtection) all.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * 8)], lamports: Math.floor(cfg.jitoTipSol * LAMPORTS_PER_SOL) }));
  all.push(...ixs);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message());
}
function feeLamports(cfg: Config, units: number) {
  return 5000 + Math.ceil((units * cfg.priorityFeeMicroLamports) / 1e6) + (cfg.frontRunProtection ? Math.floor(cfg.jitoTipSol * 1e9) : 0);
}

export async function buildBuy(cfg: Config, mint: PublicKey, user: PublicKey, lamports: number): Promise<BuiltOrder> {
  const ms = await marketState(mint);
  if (ms.venue === "migrating") throw new Error("coin is migrating to AMM; retry later");
  const tp = ms.tokenProgram;
  const userAta = getAssociatedTokenAddressSync(mint, user, true, tp);
  const ataInfo = await conn.getAccountInfo(userAta);
  const ataRent = ataInfo ? 0 : await conn.getMinimumBalanceForRentExemption(tp.equals(TOKEN_2022_PROGRAM_ID) ? 182 : 165);
  const solIn = new BN(lamports);
  if (ms.venue === "curve") {
    const { g, f } = await globals();
    const args = { global: g, feeConfig: f, mintSupply: ms.bc.tokenTotalSupply, bondingCurve: ms.bc, quoteMint: ms.bc.quoteMint };
    const tokens = getBuyTokenAmountFromSolAmount({ ...args, amount: solIn });
    const solCost = getBuySolAmountFromTokenAmount({ ...args, amount: tokens });
    const ixs = await PUMP_SDK.buyInstructions({ global: g, bondingCurveAccountInfo: ms.bcInfo, bondingCurve: ms.bc, associatedUserAccountInfo: ataInfo, mint, user, amount: tokens, solAmount: solCost, slippage: cfg.slippagePct, tokenProgram: tp });
    const tx = await assemble(cfg, user, ixs, cfg.computeUnitsCurve);
    const exec = Number(solCost.toString()) / 1e9 / (Number(tokens.toString()) / 1e6);
    return { tx, venue: "curve", side: "buy", expectedOut: tokens, minOut: tokens, inAmount: solCost, spot: ms.spot, execPrice: exec, impactPct: (exec / ms.spot - 1) * 100, feesLamports: feeLamports(cfg, cfg.computeUnitsCurve), ataRentLamports: ataRent, userAta, tokenProgram: tp };
  }
  const st = await onlineAmm.swapSolanaState(ms.poolKey, user);
  const r = buyQuoteInput({ quote: solIn, slippage: cfg.slippagePct, baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps, quoteTransferFee: st.quoteTransferFee });
  const ixs = await PUMP_AMM_SDK.buyQuoteInput(st, solIn, cfg.slippagePct);
  const tx = await assemble(cfg, user, ixs, cfg.computeUnitsAmm);
  const exec = lamports / 1e9 / (Number(r.base.toString()) / 1e6);
  const spotNow = (Number(st.poolQuoteAmount.toString()) + Number((st.pool.virtualQuoteReserves ?? new BN(0)).toString())) / 1e9 / (Number(st.poolBaseAmount.toString()) / 1e6);
  return { tx, venue: "amm", side: "buy", expectedOut: r.base, minOut: r.base, inAmount: r.maxQuote, spot: spotNow, execPrice: exec, impactPct: (exec / spotNow - 1) * 100, feesLamports: feeLamports(cfg, cfg.computeUnitsAmm) + 2_100_000 /* temp WSOL rent, refunded */, ataRentLamports: ataRent, userAta, tokenProgram: tp };
}

/** Expected SOL (lamports) from selling `tokens` now, plus venue. */
export async function quoteSell(mint: PublicKey, tokens: BN, tokenProgram?: PublicKey): Promise<{ venue: string; lamports: BN; spot: number }> {
  const ms = await marketState(mint, tokenProgram);
  if (ms.venue === "migrating") return { venue: "migrating", lamports: new BN(-1), spot: 0 };
  if (ms.venue === "curve") {
    const { g, f } = await globals();
    return { venue: "curve", lamports: getSellSolAmountFromTokenAmount({ global: g, feeConfig: f, mintSupply: ms.bc.tokenTotalSupply, bondingCurve: ms.bc, amount: tokens }), spot: ms.spot };
  }
  const st = await onlineAmm.swapSolanaState(ms.poolKey, Keypair.generate().publicKey);
  const r = sellBaseInput({ base: tokens, slippage: 1, baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps, quoteTransferFee: st.quoteTransferFee });
  return { venue: "amm", lamports: r.uiQuote, spot: ms.spot };
}

export async function buildSell(cfg: Config, mint: PublicKey, user: PublicKey, tokens: BN, closeAta: boolean, slippageOverride?: number): Promise<BuiltOrder> {
  const slip = slippageOverride ?? cfg.slippagePct;
  const ms = await marketState(mint);
  if (ms.venue === "migrating") throw new Error("coin is migrating to AMM; retry later");
  const tp = ms.tokenProgram;
  const userAta = getAssociatedTokenAddressSync(mint, user, true, tp);
  let ixs: TransactionInstruction[]; let expected: BN; let minOut: BN; let units: number;
  if (ms.venue === "curve") {
    const { g, f } = await globals();
    expected = getSellSolAmountFromTokenAmount({ global: g, feeConfig: f, mintSupply: ms.bc.tokenTotalSupply, bondingCurve: ms.bc, amount: tokens });
    ixs = await PUMP_SDK.sellInstructions({ global: g, bondingCurveAccountInfo: ms.bcInfo, bondingCurve: ms.bc, mint, user, amount: tokens, solAmount: expected, slippage: slip, tokenProgram: tp, mayhemMode: ms.bc.isMayhemMode ?? false, cashback: ms.bc.isCashbackCoin ?? false });
    minOut = expected.muln(100 - slip).divn(100); units = cfg.computeUnitsCurve;
  } else {
    const st = await onlineAmm.swapSolanaState(ms.poolKey, user);
    const r = sellBaseInput({ base: tokens, slippage: slip, baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps, quoteTransferFee: st.quoteTransferFee });
    ixs = await PUMP_AMM_SDK.sellBaseInput(st, tokens, slip);
    expected = r.uiQuote; minOut = r.minQuote; units = cfg.computeUnitsAmm;
  }
  if (closeAta) ixs.push(createCloseAccountInstruction(userAta, user, user, [], tp));
  const tx = await assemble(cfg, user, ixs, units);
  const exec = Number(expected.toString()) / 1e9 / (Number(tokens.toString()) / 1e6);
  return { tx, venue: ms.venue, side: "sell", expectedOut: expected, minOut, inAmount: tokens, spot: ms.spot, execPrice: exec, impactPct: (1 - exec / ms.spot) * 100, feesLamports: feeLamports(cfg, units), ataRentLamports: 0, userAta, tokenProgram: tp };
}

/** Simulate (no signature needed). Returns post-sim token balance of userAta and lamports of user. */
export async function simulate(tx: VersionedTransaction, user: PublicKey, userAta: PublicKey) {
  const res = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: [userAta.toBase58(), user.toBase58()] } });
  const v = res.value;
  let postTokens: BN | null = null; let postLamports: number | null = null;
  const a0 = v.accounts?.[0]; const a1 = v.accounts?.[1];
  if (a0 && a0.data?.[0]) { const b = Buffer.from(a0.data[0] as string, "base64"); if (b.length >= 72) postTokens = new BN(b.subarray(64, 72), "le"); }
  if (a1) postLamports = a1.lamports;
  return { ok: !v.err, err: v.err, logs: v.logs ?? [], units: v.unitsConsumed, postTokens, postLamports };
}

async function sendJito(b64: string): Promise<string> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] });
  const rs = await Promise.allSettled(JITO_ENDPOINTS.map((e) => fetch(e, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then(async (r) => { const j: any = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result as string; })));
  const ok = rs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string> | undefined;
  if (ok) return ok.value;
  throw new Error("all Jito endpoints failed");
}

async function waitConfirm(sig: string, timeoutMs: number): Promise<"confirmed" | "failed" | "timeout"> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = (await conn.getSignatureStatuses([sig])).value[0];
    if (s?.err) return "failed";
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return "confirmed";
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "timeout";
}

/** Signs and sends. Jito-only if front-run protection (same signed tx re-sent to RPC on timeout if allowed). */
export async function signAndSend(cfg: Config, tx: VersionedTransaction, signer: Keypair): Promise<{ sig: string; status: string }> {
  tx.sign([signer]);
  const raw = Buffer.from(tx.serialize());
  const b64 = raw.toString("base64");
  const bs58 = (await import("bs58")).default;
  const sig = bs58.encode(tx.signatures[0]);
  if (cfg.frontRunProtection) {
    try { await sendJito(b64); } catch { /* fall through */ }
    let st = await waitConfirm(sig, 25_000);
    if (st === "timeout" && cfg.jitoFallbackToRpc) {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
      st = await waitConfirm(sig, 35_000);
    }
    return { sig, status: st };
  }
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  return { sig, status: await waitConfirm(sig, 45_000) };
}

export async function tokenBalance(ata: PublicKey): Promise<BN> {
  try { const b = await conn.getTokenAccountBalance(ata, "confirmed"); return new BN(b.value.amount); } catch { return new BN(0); }
}
