# pump-bot — 24/7 pump.fun trader (LIVE, dedicated wallet)

Built on the official `@pump-fun/pump-sdk` (bonding curve) and `@pump-fun/pump-swap-sdk` (graduated PumpSwap AMM),
following pump-fun-skills/swap (slippage, on-chain token-program check, Jito-only front-run protection with tip).

- Wallet: `secrets/wallet.json` (chmod 600, never printed). Public address shown by `npm run status`.
- Risk config: `config.json` (hot-reloaded every 15s by the bot).
- Trades: `trades.csv`; logs: `data/bot.log`; state: `data/state.json`.

## Flow
1. Idle until wallet balance >= `activationMinBalanceSol` (0.1 SOL); that balance becomes the start balance.
2. Discovery: websocket `logsSubscribe` on the pump program; decodes Create/Trade/Complete events (SOL-quoted coins only).
3. Score 0-100: momentum (recent unique buyers), buy pressure, net inflow, bonding progress, dev holdings, holder
   concentration (getTokenLargestAccounts, or event-derived if the RPC refuses). Hard rejects: dev sold, dev > 10%,
   create-slot snipers/bundle > 20%, top1 > 12%, top10 > 35%, mint/freeze authority, mayhem mode, low liquidity.
4. Before every order: fresh quote, price impact cap, fee % cap, SOL reserve check, `simulateTransaction` must succeed
   and return >= min tokens. Then sign, send to Jito (fallback to RPC after 25s if enabled), confirm.
5. Exits: TP +50%, SL -25%, max hold 45 min. Works on curve and after graduation (AMM). Full sells close the token
   account to recover rent.
6. Global stop: wallet value (SOL + positions) down 40% from start -> mode `halted`, no new buys (exits keep running).

## Commands
    npm run status                      # balance, mode, open positions, PnL
    pm2 logs pump-bot                   # live log
    pm2 stop pump-bot / pm2 restart pump-bot
    npm run dryrun                      # no-funds test: discovery, scoring, quote, tx build, simulation
    DRY_RUN=1 in .env                   # never send transactions
    RPC_URL / WS_URL in .env            # e.g. a Helius/Triton/QuickNode endpoint (recommended)
