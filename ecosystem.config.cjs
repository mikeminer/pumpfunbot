module.exports = { apps: [{
  name: "pump-bot", cwd: "/workspace/pump-bot", script: "node_modules/.bin/tsx", args: "src/bot.ts",
  autorestart: true, max_restarts: 1000, restart_delay: 10000, exp_backoff_restart_delay: 2000,
  out_file: "/workspace/pump-bot/data/bot.log", error_file: "/workspace/pump-bot/data/bot.err.log", merge_logs: true, time: false,
  env: { NODE_NO_WARNINGS: "1" },
}] };
